import { NextResponse } from "next/server";
import { checkGwsStatus } from "@/lib/gws";

export async function GET() {
  const status = await checkGwsStatus();
  return NextResponse.json(status);
}
