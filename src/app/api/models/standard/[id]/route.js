import { NextResponse } from "next/server";
import {
  getStandardModelById,
  updateStandardModel,
  deleteStandardModel,
} from "@/lib/localDb";
import { normalizeStandardModelInput, assertStandardModelNameAvailable } from "@/lib/standardModels/service";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { id } = await params;
  const model = await getStandardModelById(id);
  if (!model) return NextResponse.json({ error: "Standard model not found" }, { status: 404 });
  return NextResponse.json(model);
}

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const current = await getStandardModelById(id);
    if (!current) return NextResponse.json({ error: "Standard model not found" }, { status: 404 });
    const body = await request.json();
    const data = normalizeStandardModelInput({ ...current, ...body });
    await assertStandardModelNameAvailable(data.publicName, id);
    const model = await updateStandardModel(id, data);
    return NextResponse.json(model);
  } catch (error) {
    const message = error?.message || "Failed to update standard model";
    const status = /already exists|already used|may only|required/.test(message) ? 400 : 500;
    console.error("Error updating standard model:", error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_request, { params }) {
  try {
    const { id } = await params;
    const deleted = await deleteStandardModel(id);
    if (!deleted) return NextResponse.json({ error: "Standard model not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting standard model:", error);
    return NextResponse.json({ error: "Failed to delete standard model" }, { status: 500 });
  }
}
