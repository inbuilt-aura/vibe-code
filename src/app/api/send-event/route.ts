import { inngest } from "../../../inngest/client";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { name, data, id } = await request.json();

    if (!name || !data) {
      return NextResponse.json({ error: "Missing name or data" }, { status: 400 });
    }

    console.log("Sending event:", { name, data, id });

    // Send event using Inngest client
    await inngest.send({
      name,
      data,
      id,
    });

    console.log("Event sent successfully");
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error sending event:", error);
    return NextResponse.json({ error: "Failed to send event" }, { status: 500 });
  }
}
