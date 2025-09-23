import { NextResponse } from "next/server";
import { getResult } from "../../../../inngest/functions";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ eventId?: string }> }
) {
  const { eventId } = await params;
  if (!eventId) {
    return NextResponse.json({ error: "Missing eventId", status: "failed" }, { status: 400 });
  }
  const result = getResult(eventId);
  if (!result) {
    return NextResponse.json({ status: "pending" });
  }
  return NextResponse.json(result);
}
