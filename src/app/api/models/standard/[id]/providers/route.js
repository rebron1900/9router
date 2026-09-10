import { NextResponse } from "next/server";
import {
  getStandardModelById,
  getStandardModelBindings,
  createStandardModelBinding,
  replaceStandardModelMappings,
} from "@/lib/localDb";
import { normalizeBindingInput, normalizeMappings } from "@/lib/standardModels/service";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { id } = await params;
  const model = await getStandardModelById(id);
  if (!model) return NextResponse.json({ error: "Standard model not found" }, { status: 404 });
  return NextResponse.json({ providers: await getStandardModelBindings(id) });
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const model = await getStandardModelById(id);
    if (!model) return NextResponse.json({ error: "Standard model not found" }, { status: 404 });
    const body = await request.json();
    const binding = await createStandardModelBinding(id, normalizeBindingInput(body));
    const mappings = normalizeMappings(body.mappings);
    if (mappings.length) await replaceStandardModelMappings(binding.id, mappings);
    return NextResponse.json({ binding, providers: await getStandardModelBindings(id) }, { status: 201 });
  } catch (error) {
    const message = error?.message || "Failed to add provider binding";
    const status = /required|UNIQUE|unique/i.test(message) ? 400 : 500;
    console.error("Error adding standard model provider:", error);
    return NextResponse.json({ error: message }, { status });
  }
}
