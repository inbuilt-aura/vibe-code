import { inngest } from "./client";
import { Sandbox } from "@e2b/code-interpreter";
import { getSandbox } from "./utils";
import { PROMPT } from "../prompt";
// import { createTool } from "@inngest/agent-kit"
// import z from "zod";
// import { Agent } from "@inngest/agent-kit";

type Message = {
  role: string;
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
};

const resultStore = new Map<
  string,
  { output?: string; sandboxUrl?: string; error?: string; status: string; summary?: string }
>();



// Call OpenRouter with optional messages and tools (OpenAI function-calling style)
async function callOpenRouter(
  promptOrMessages: string | Message[],
  systemMessage?: string,
  tools?: unknown[]
) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "Missing OPENROUTER_API_KEY. Add it to your .env (server env) and restart. See https://openrouter.ai/docs#authentication"
    );
  }

  const configuredUrl = process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1";
  const baseUrl = configuredUrl.replace(/\/$/, "").replace(/\/chat\/completions$/, "");
  const url = `${baseUrl}/chat/completions`;

  // Build messages
  const messages = Array.isArray(promptOrMessages)
    ? promptOrMessages
    : [
      { role: "system", content: systemMessage },
      { role: "user", content: promptOrMessages },
    ];

  const body: Record<string, unknown> = {
    model: process.env.OPENROUTER_MODEL || "openai/gpt-oss-20b:free",
    messages,
    max_tokens: 1000,
    temperature: 0.7,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  console.log("OpenRouter request:", { url, model: body.model, tools: !!body.tools });
  let response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      // Optional but recommended by OpenRouter for routing/analytics
      'HTTP-Referer': process.env.OPENROUTER_REFERER || 'http://localhost:3000',
      'X-Title': process.env.OPENROUTER_X_TITLE || 'vibe-code',
    },
    body: JSON.stringify(body),

  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("OpenRouter error:", { status: response.status, error: errorText });
    // Auto-retry without tools if provider doesn't support tool use
    if (response.status === 404 && /No endpoints found that support tool use/i.test(errorText) && body.tools) {
      console.log("Retrying OpenRouter call without tools...");
      delete body.tools;
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.OPENROUTER_REFERER || 'http://localhost:3000',
          'X-Title': process.env.OPENROUTER_X_TITLE || 'vibe-code',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const secondError = await response.text();
        console.error("OpenRouter retry error:", { status: response.status, error: secondError });
        throw new Error(`OpenRouter API error: ${response.status} ${secondError}`);
      }
    } else {
      throw new Error(`OpenRouter API error: ${response.status} ${errorText}`);
    }
  }

  const data = await response.json();
  return data;
}


export const helloWorld = inngest.createFunction(
  { id: "hello-world" },
  { event: "test/hello.world" },
  async ({ event }) => {
    return { message: `Hello, ${event.data?.name || "world"}!` };
  }
);

// Sandbox-only (no AI)
export const sandboxFunction = inngest.createFunction(
  { id: "sandbox-fn" },
  { event: "sandbox/create" },
  async ({ event, step }) => {
    const sandboxId = await step.run("create-sandbox", async () => {
      const sandbox = await Sandbox.create("codesaas");
      return sandbox.sandboxId;
    });

    const sandboxUrl = await step.run("get-sandbox-url", async () => {
      const sandbox = await getSandbox(sandboxId);
      return `https://${sandbox.getHost(3000)}`;
    });

    let terminalResult: { stdout?: string; stderr?: string; exitCode?: number } | undefined;

    const command = event.data?.command as string | undefined;
    if (command && typeof command === "string") {
      terminalResult = await step.run("terminal", async () => {
        const sandbox = await getSandbox(sandboxId);
        const buffers = { stdout: "", stderr: "" } as { stdout: string; stderr: string };

        const result = await sandbox.commands.run(command, {
          onStdout: (data: string) => {
            buffers.stdout += data;
          },
          onStderr: (data: string) => {
            buffers.stderr += data;
          },
        });

        // Prefer streamed buffers; fall back to aggregated result fields
        return {
          stdout: buffers.stdout || (result.stdout as string | undefined),
          stderr: buffers.stderr || (result.stderr as string | undefined),
          exitCode: result.exitCode,
        };
      });
    }

    return { sandboxId, sandboxUrl, terminalResult };
  }
);

// Grok Agent (general Q&A)
export const runGrokAgent = inngest.createFunction(
  { id: "run-grok-agent" },
  { event: "ai/grok.run" },
  async ({ event }) => {
    const eventId = event.data?.eventId;
    const prompt = event.data?.prompt;

    if (!eventId || typeof eventId !== "string") {
      throw new Error("Missing or invalid eventId in event data");
    }

    if (!prompt || typeof prompt !== "string") {
      throw new Error("Prompt not found in event data");
    }

    const first = await callOpenRouter(
      prompt,
      PROMPT
    );
    const content = first.choices?.[0]?.message?.content || '';
    const summaryMatch = typeof content === 'string' ? content.match(/<task_summary>[\s\S]*?<\/task_summary>/) : null;
    const summary = summaryMatch ? summaryMatch[0] : undefined;
    resultStore.set(eventId, { output: content, status: "completed", ...(summary ? { summary } : {}) });
    return { output: content, summary };
  }
);


// Code Agent + Sandbox
export const runCodeWithSandbox = inngest.createFunction(
  { id: "run-code-with-sandbox" },
  { event: "ai/code.run" },
  async ({ event, step }) => {
    const eventId = event.data?.eventId;
    const value = event.data?.value;

    if (!eventId || typeof eventId !== "string") {
      throw new Error("Missing or invalid eventId in event data");
    }

    console.log("Starting function execution for eventId:", eventId);

    try {
      if (!value || typeof value !== "string") {
        throw new Error("Missing 'value' in event data");
      }

      console.log("Step 1: Creating sandbox");

      // 1️⃣ Create sandbox FIRST (tools need it)
      const sandboxId = await step.run("create-sandbox", async () => {
        if (!process.env.E2B_API_KEY) {
          throw new Error(
            "Missing E2B_API_KEY. Create one at https://e2b.dev, add it to .env, and restart."
          );
        }
        console.log("Creating E2B sandbox...");
        console.log("E2B_API_KEY present:", !!process.env.E2B_API_KEY);
        console.log("Template name: codesaas");
        const sandbox = await Sandbox.create("codesaas");
        console.log("Sandbox created with ID:", sandbox.sandboxId);
        return sandbox.sandboxId;
      });

      console.log("Step 2: Getting sandbox URL");

      // 2️⃣ Get sandbox URL
      const sandboxUrl = await step.run("get-sandbox-url", async () => {
        console.log("Getting sandbox URL for ID:", sandboxId);
        const sandbox = await getSandbox(sandboxId);
        const url = `https://${sandbox.getHost(3000)}`;
        console.log("Sandbox URL:", url);
        return url;
      });

      // 3️⃣ Optional: verify sandbox is responsive
      await step.run("verify-sandbox", async () => {
        const sandbox = await getSandbox(sandboxId);
        const result = await sandbox.commands.run("echo sandbox-ready");
        console.log("verify-sandbox stdout:", result.stdout?.trim());
        if (result.exitCode !== 0) {
          throw new Error(`Sandbox verification failed: ${result.stderr}`);
        }
      });

      console.log("Step 3: Generating code for:", value);

      // 4️⃣ Generate code with tools support (terminal)
      const output = await step.run("generate-code", async () => {
        console.log("Calling OpenRouter API with tools...");

        const terminalTool = {
          type: "function",
          function: {
            name: "terminal",
            description: "Run a shell command in the E2B sandbox and return stdout/stderr",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        };

        const createOrUpdateFilesTool = {
          type: "function",
          function: {
            name: "createOrUpdateFiles",
            description: "Create or update files in the E2B sandbox",
            parameters: {
              type: "object",
              properties: {
                files: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      content: { type: "string" },
                    },
                    required: ["path", "content"],
                  },
                },
              },
              required: ["files"],
            },
          },
        };

        const readFilesTool = {
          type: "function",
          function: {
            name: "readFiles",
            description: "Read files from the E2B sandbox and return their contents",
            parameters: {
              type: "object",
              properties: {
                files: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["files"],
            },
          },
        };

        // Messages start
        const messages: Message[] = [
          { role: "system", content: PROMPT },
          { role: "user", content: `Write the following snippet: ${value}` },
        ];

        const toolsArr = [terminalTool, createOrUpdateFilesTool, readFilesTool];
        const maxIterations = Number(process.env.AGENT_MAX_ITER || 8);
        let finalText = '';

        for (let iter = 0; iter < maxIterations; iter++) {
          const resp = await callOpenRouter(messages, undefined, toolsArr);
          const msg = resp.choices?.[0]?.message;

          if (msg?.tool_calls && msg.tool_calls.length > 0) {
            for (const tc of msg.tool_calls) {
              if (tc?.function?.name === "terminal") {
                const args = JSON.parse(tc.function.arguments || '{}');
                const command = String(args.command || '').trim();
                if (!command) continue;
                const sandbox = await getSandbox(sandboxId);
                const result = await sandbox.commands.run(command);
                const toolContent = JSON.stringify({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
                messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
                messages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
              } else if (tc?.function?.name === "createOrUpdateFiles") {
                const args = JSON.parse(tc.function.arguments || '{}');
                const files = Array.isArray(args.files) ? args.files : [];
                const sandbox = await getSandbox(sandboxId);
                const updated: Record<string, string> = {};
                for (const f of files) {
                  if (typeof f?.path === 'string' && typeof f?.content === 'string') {
                    await sandbox.files.write(f.path, f.content);
                    updated[f.path] = f.content;
                  }
                }
                const toolContent = JSON.stringify({ updatedPaths: Object.keys(updated) });
                messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
                messages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
              } else if (tc?.function?.name === "readFiles") {
                const args = JSON.parse(tc.function.arguments || '{}');
                const files = Array.isArray(args.files) ? args.files : [];
                const sandbox = await getSandbox(sandboxId);
                const contents: Array<{ path: string; content: string }> = [];
                for (const p of files) {
                  if (typeof p === 'string' && p.length > 0) {
                    const content = await sandbox.files.read(p);
                    contents.push({ path: p, content: String(content) });
                  }
                }
                const toolContent = JSON.stringify(contents);
                messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
                messages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
              }
            }
            continue;
          }

          if (typeof msg?.content === 'string' && msg.content.includes('<tool')) {
            const text: string = msg.content;
            const toolCallRegex = /<tool\s+name=\"([a-zA-Z0-9_\-]+)\">([\s\S]*?)<\/tool>/g;
            let match: RegExpExecArray | null;
            const toolResults: Array<{ id: string; content: string }> = [];
            while ((match = toolCallRegex.exec(text)) !== null) {
              const toolName = match[1];
              const rawJson = match[2];
              let args: Record<string, unknown> = {};
              try { args = JSON.parse(rawJson); } catch { }
              if (toolName === 'terminal') {
                const command = String((args as { command?: unknown }).command || '').trim();
                if (!command) continue;
                const sandbox = await getSandbox(sandboxId);
                const result = await sandbox.commands.run(command);
                const toolContent = JSON.stringify({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
                toolResults.push({ id: 'terminal-fallback', content: toolContent });
              } else if (toolName === 'createOrUpdateFiles') {
                const files = Array.isArray((args as { files?: unknown }).files) ? (args as { files: unknown[] }).files : [];
                const sandbox = await getSandbox(sandboxId);
                const updated: Record<string, string> = {};
                for (const f of files) {
                  if (typeof (f as { path?: unknown }).path === 'string' && typeof (f as { content?: unknown }).content === 'string') {
                    await sandbox.files.write((f as { path: string }).path, (f as { content: string }).content);
                    updated[(f as { path: string }).path] = (f as { content: string }).content;
                  }
                }
                const toolContent = JSON.stringify({ updatedPaths: Object.keys(updated) });
                toolResults.push({ id: 'createOrUpdateFiles-fallback', content: toolContent });
              } else if (toolName === 'readFiles') {
                const files = Array.isArray((args as { files?: unknown }).files) ? (args as { files: unknown[] }).files : [];
                const sandbox = await getSandbox(sandboxId);
                const contents: Array<{ path: string; content: string }> = [];
                for (const p of files) {
                  if (typeof p === 'string' && p.length > 0) {
                    const content = await sandbox.files.read(p);
                    contents.push({ path: p, content: String(content) });
                  }
                }
                const toolContent = JSON.stringify(contents);
                toolResults.push({ id: 'readFiles-fallback', content: toolContent });
              }
            }
            if (toolResults.length > 0) {
              messages.push({ role: 'assistant', content: msg.content });
              for (const tr of toolResults) {
                messages.push({ role: 'tool', tool_call_id: tr.id, content: tr.content });
              }
              continue;
            }
          }

          finalText = msg?.content || '';
          break;
        }

        const producedText = finalText;
        const summaryMatch = typeof producedText === 'string' ? producedText.match(/<task_summary>[\s\S]*?<\/task_summary>/) : null;
        const summary = summaryMatch ? summaryMatch[0] : undefined;
        console.log("Code generation result:", producedText);
        return { finalText: producedText, summary };
      });

      const safeOutput =
        typeof output === "string" ? output : (output?.finalText ?? JSON.stringify(output));
      const summary = typeof output === 'object' ? output?.summary : undefined;

      console.log("Function completed successfully");

      resultStore.set(eventId, {
        output: safeOutput,
        sandboxUrl,
        status: "completed",
        ...(summary ? { summary } : {}),
      });

      return { output: safeOutput, sandboxUrl, summary };
    } catch (error) {
      console.error("Function execution failed:", error);
      resultStore.set(eventId, {
        error: error instanceof Error ? error.message : "Unknown error",
        status: "failed",
      });
      throw error;
    }
  }
);


export function getResult(eventId: string) {
  return resultStore.get(eventId);
}
