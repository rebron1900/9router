import { NextResponse } from "next/server";
import {
  getStandardModelById,
  getStandardModelBindings,
  updateStandardModelBinding,
  deleteStandardModelBinding,
  replaceStandardModelMappings,
} from "@/lib/localDb";
import { normalizeBindingInput, normalizeMappings } from "@/lib/standardModels/service";

export const dynamic = "force-dynamic";

async function getBinding(standardModelId, bindingId) {
  const bindings = await getStandardModelBindings(standardModelId);
  return bindings.find((binding) => binding.id === bindingId) || null;
}

export async function PATCH(request, { params }) {
  try {
    const { id, bindingId } = await params;
    if (!await getStandardModelById(id)) return NextResponse.json({ error: "Standard model not found" }, { status: 404 });
    if (!await getBinding(id, bindingId)) return NextResponse.json({ error: "Provider binding not found" }, { status: 404 });
    const body = await request.json();
    const current = await getBinding(id, bindingId);
    const binding = await updateStandardModelBinding(
      bindingId,
      normalizeBindingInput({ ...current, ...body }),
    );
    if (Array.isArray(body.mappings)) await replaceStandardModelMappings(bindingId, normalizeMappings(body.mappings));
    return NextResponse.json({ binding, mappings: await getBinding(id, bindingId) });
  } catch (error) {
    const message = error?.message || "Failed to update provider binding";
    console.error("Error updating standard model provider:", error);
    return NextResponse.json({ error: message }, { status: /required|UNIQUE|unique/i.test(message) ? 400 : 500 });
  }
}

export async function DELETE(_request, { params }) {
  const { id, bindingId } = await params;
  if (!await getStandardModelById(id)) return NextResponse.json({ error: "Standard model not found" }, { status: 404 });
  if (!await getBinding(id, bindingId)) return NextResponse.json({ error: "Provider binding not found" }, { status: 404 });
  const deleted = await deleteStandardModelBinding(bindingId);
  return NextResponse.json({ success: deleted });
}
