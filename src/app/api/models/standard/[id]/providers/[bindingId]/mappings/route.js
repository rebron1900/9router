import { NextResponse } from "next/server";
import { getStandardModelById, getStandardModelBindings, replaceStandardModelMappings } from "@/lib/localDb";
import { normalizeMappings } from "@/lib/standardModels/service";

export const dynamic = "force-dynamic";

export async function PUT(request, { params }) {
  try {
    const { id, bindingId } = await params;
    if (!await getStandardModelById(id)) return NextResponse.json({ error: "Standard model not found" }, { status: 404 });
    const binding = (await getStandardModelBindings(id)).find((item) => item.id === bindingId);
    if (!binding) return NextResponse.json({ error: "Provider binding not found" }, { status: 404 });
    const body = await request.json();
    const mappings = await replaceStandardModelMappings(bindingId, normalizeMappings(body.mappings));
    return NextResponse.json({ mappings });
  } catch (error) {
    console.error("Error replacing standard model mappings:", error);
    return NextResponse.json({ error: error?.message || "Failed to replace mappings" }, { status: 400 });
  }
}
