import { NextResponse } from "next/server";
import { getStandardModels } from "@/lib/localDb";
import { getBundledStandardModelCatalog } from "@/lib/standardModels/catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const catalog = getBundledStandardModelCatalog();
    const registered = await getStandardModels();
    const registeredByName = new Map(registered.map((model) => [model.publicName, model]));
    return NextResponse.json({
      ...catalog,
      models: catalog.models.map((model) => ({
        ...model,
        registered: registeredByName.has(model.publicName),
        registeredModel: registeredByName.get(model.publicName) || null,
      })),
      registeredModels: registered,
    });
  } catch (error) {
    console.error("Error fetching standard model catalog:", error);
    return NextResponse.json({ error: "Failed to fetch standard model catalog" }, { status: 500 });
  }
}
