"use client";

import React, { useState } from "react";
import { toast } from "sonner";

function Page() {
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setResult("");
    try {
      // Send event to Inngest API
      const eventId = crypto.randomUUID();
      const res = await fetch("/api/send-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "ai/code.run",
          data: { value: prompt, eventId },
          id: eventId,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        // Poll for the result
        await pollForResult(eventId);
      } else {
        setResult(data.error || "Error sending event");
        toast.error(data.error || "Error sending event");
      }
    } catch {
      setResult("Error calling Grok agent");
      toast.error("Error calling Grok agent");
    }
    setLoading(false);
  };

  const pollForResult = async (eventId: string) => {
    const maxAttempts = 30; // 30 seconds max
    let attempts = 0;

    const poll = async () => {
      attempts++;
      try {
        const res = await fetch(`/api/result/${eventId}`);
        const data = await res.json();

        if (data.status === "completed" && data.output) {
          setResult(data.output);
          toast.success("Grok agent responded successfully!");
          return;
        } else if (data.status === "failed") {
          setResult(data.error || "Grok agent failed");
          toast.error(data.error || "Grok agent failed");
          return;
        } else if (attempts >= maxAttempts) {
          setResult("Timeout waiting for response");
          toast.error("Timeout waiting for response");
          return;
        }

        // Continue polling
        setTimeout(poll, 1000);
      } catch {
        if (attempts >= maxAttempts) {
          setResult("Error polling for result");
          toast.error("Error polling for result");
        } else {
          setTimeout(poll, 1000);
        }
      }
    };

    poll();
  };

  return (
    <div className="max-w-xl mx-auto py-10">
      <h1 className="text-2xl font-bold mb-4">Grok Agent Demo</h1>
      <form onSubmit={handleSubmit} className="mb-4">
        <input
          type="text"
          className="border px-3 py-2 w-full mb-2 rounded"
          placeholder="Enter your prompt..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
        />
        <button
          type="submit"
          className="bg-blue-600 text-white px-4 py-2 rounded"
          disabled={loading}
        >
          {loading ? "Loading..." : "Ask Grok"}
        </button>
      </form>
      {result && (
        <div className="bg-gray-100 p-4 rounded">
          <strong>Result:</strong>
          <pre className="whitespace-pre-wrap mt-2">{result}</pre>
        </div>
      )}
    </div>
  );
}

export default Page;
