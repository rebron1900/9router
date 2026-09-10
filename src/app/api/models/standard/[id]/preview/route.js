import { NextResponse } from "next/server";
import { getStandardModelById, getStandardModelBindings } from "@/lib/localDb";
import { planStandardModelCandidates } from "@/lib/standardModels/planner";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const model = await getStandardModelById(id);
    if (!model) return NextResponse.json({ error: "Standard model not found" }, { status: 404 });
    const body = await request.json().catch(() => ({}));
    const preview = planStandardModelCandidates({
      model: {
        ...model,
        requiredCapabilities: body.requiredCapabilities || {},
      },
      bindings: await getStandardModelBindings(id),
      requestFormat: body.requestFormat || null,
      operation: body.operation || null,
      requireConfiguredProvider: body.requireConfiguredProvider === true,
    });
    return NextResponse.json({ model, ...preview });
  } catch (error) {
    console.error("Error previewing standard model route:", error);
    return NextResponse.json({ error: "Failed to preview standard model route" }, { status: 500 });
  }
}
