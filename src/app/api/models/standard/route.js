import { NextResponse } from "next/server";
import {
  getStandardModels,
  createStandardModel,
} from "@/lib/localDb";
import { normalizeStandardModelInput, assertStandardModelNameAvailable } from "@/lib/standardModels/service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ models: await getStandardModels() });
  } catch (error) {
    console.error("Error fetching standard models:", error);
    return NextResponse.json({ error: "Failed to fetch standard models" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const data = normalizeStandardModelInput(body);
    await assertStandardModelNameAvailable(data.publicName);
    const model = await createStandardModel(data);
    return NextResponse.json(model, { status: 201 });
  } catch (error) {
    const message = error?.message || "Failed to create standard model";
    const status = /already exists|already used|may only|required/.test(message) ? 400 : 500;
    console.error("Error creating standard model:", error);
    return NextResponse.json({ error: message }, { status });
  }
}
