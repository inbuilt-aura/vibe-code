import { inngest } from "./client";
import { Sandbox } from "@e2b/code-interpreter";
import { getSandbox } from "./utils";

// ======================
// Minimal result store (dev only)
// ======================
const resultStore = new Map<
  string,
  { output?: string; sandboxUrl?: string; error?: string; status: string }
>();


async function callOpenRouter(prompt: string, systemMessage: string) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "Missing OPENROUTER_API_KEY. Add it to your .env (server env) and restart. See https://openrouter.ai/docs#authentication"
    );
  }

  // Allow OPENROUTER_API_URL to be either a base (https://openrouter.ai/api/v1)
  // or the full endpoint (https://openrouter.ai/api/v1/chat/completions)
  const configuredUrl = process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1";
  const baseUrl = configuredUrl.replace(/\/$/, "").replace(/\/chat\/completions$/, "");
  const url = `${baseUrl}/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      // Optional but recommended by OpenRouter for routing/analytics
      'HTTP-Referer': process.env.OPENROUTER_REFERER || 'http://localhost:3000',
      'X-Title': process.env.OPENROUTER_X_TITLE || 'vibe-code',
    },
    body: JSON.stringify({
      model: "x-ai/grok-4-fast:free",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: prompt }
      ],
      max_tokens: 1000,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} ${error}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
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
  async ({ step }) => {
    const sandboxId = await step.run("create-sandbox", async () => {
      const sandbox = await Sandbox.create("codesaas");
      return sandbox.sandboxId;
    });

    const sandboxUrl = await step.run("get-sandbox-url", async () => {
      const sandbox = await getSandbox(sandboxId);
      return `https://${sandbox.getHost(3000)}`;
    });

    return { sandboxId, sandboxUrl };
  }
);

// Grok Agent (general Q&A)
export const runGrokAgent = inngest.createFunction(
  { id: "run-grok-agent" },
  { event: "ai/grok.run" },
  async ({ event }) => {
    const eventId = event.data?.eventId;
    const prompt = event.data?.prompt;

    if (!prompt || typeof prompt !== "string") {
      throw new Error("Prompt not found in event data");
    }

    const output = await callOpenRouter(prompt, "You are a helpful assistant. Respond concisely with clear answers.");

    resultStore.set(eventId, { output, status: "completed" });
    return { output };
  }
);

// Code Agent + Sandbox
export const runCodeWithSandbox = inngest.createFunction(
  { id: "run-code-with-sandbox" },
  { event: "ai/code.run" },
  async ({ event, step }) => {
    const eventId = event.data?.eventId;
    const value = event.data?.value;

    console.log("Starting function execution for eventId:", eventId);

    try {
      if (!value || typeof value !== "string") {
        throw new Error("Missing 'value' in event data");
      }

      console.log("Step 1: Generating code for:", value);

      // 1️⃣ Generate code
      const output = await step.run("generate-code", async () => {
        console.log("Calling OpenRouter API...");
        const result = await callOpenRouter(
          `Write the following snippet: ${value}`,
          "You are a helpful assistant. Always return clean, runnable code snippets."
        );
        console.log("Code generation result:", result);
        return result;
      });

      const safeOutput =
        typeof output === "string" ? output : JSON.stringify(output);

      console.log("Step 2: Creating sandbox");

      // 2️⃣ Create sandbox
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

      console.log("Step 3: Getting sandbox URL");

      // 3️⃣ Get sandbox URL
      const sandboxUrl = await step.run("get-sandbox-url", async () => {
        console.log("Getting sandbox URL for ID:", sandboxId);
        const sandbox = await getSandbox(sandboxId);
        const url = `https://${sandbox.getHost(3000)}`;
        console.log("Sandbox URL:", url);
        return url;
      });

      console.log("Function completed successfully");

      resultStore.set(eventId, {
        output: safeOutput,
        sandboxUrl,
        status: "completed",
      });

      return { output: safeOutput, sandboxUrl };
    } catch (error) {
      console.error("Function execution failed:", error);
      resultStore.set(eventId, {
        error: error instanceof Error ? error.message : "Unknown error",
        status: "failed",
      });
      throw error; // Re-throw to mark function as failed
    }
  }
);

// ======================
// Polling Helper
// ======================
export function getResult(eventId: string) {
  return resultStore.get(eventId);
}
