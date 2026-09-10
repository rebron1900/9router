import { NextResponse } from "next/server";
import { getStandardModels, reorderStandardModels } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function PATCH(request) {
  try {
    const body = await request.json();
    if (!Array.isArray(body?.ids)) {
      return NextResponse.json({ error: "ids must be an array" }, { status: 400 });
    }
    const ids = await reorderStandardModels(body.ids);
    const models = await getStandardModels();
    return NextResponse.json({ ids, models });
  } catch (error) {
    console.error("Error reordering standard models:", error);
    return NextResponse.json({ error: "Failed to reorder standard models" }, { status: 500 });
  }
}
