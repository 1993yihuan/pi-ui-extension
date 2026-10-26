import assert from "node:assert/strict";
import test from "node:test";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { normalizeContext, type Provider } from "@earendil-works/pi-ai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { estimateProviderToolsTokens, installContextEstimates } from "./data.ts";

const tool = { name: "read", description: "Read a file", parameters: createReadTool(process.cwd()).parameters };
const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
const messages = [{ role: "user" as const, content: [image], timestamp: 1 }];
const tokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);
const toolTokens = (snapshot: ReturnType<ReturnType<typeof installContextEstimates>["getSnapshot"]>) =>
  snapshot.categories.find(category => category.name === "Tools")!.tokens;

function trackerForContext() {
  const handlers = new Map<string, Function>();
  const tracker = installContextEstimates({
    on: (name: string, fn: Function) => handlers.set(name, fn),
    getActiveTools: () => [tool.name], getAllTools: () => [tool],
  } as any, () => {});
  const ctx = { sessionManager: { buildSessionProjection: () => ({ messages }) }, getSystemPrompt: () => "" };
  const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
  emit("context", { messages });
  return { tracker, emit };
}

test("unknown provider payloads preserve context tools and images instead of reporting zero", () => {
  const { tracker, emit } = trackerForContext();
  const fallback = tracker.getSnapshot();
  assert.ok(toolTokens(fallback)! > 0);
  assert.deepEqual(fallback.imagesWire, { images: 1, source: "message" });
  const cyclic: any = {}; cyclic.self = cyclic;
  for (const payload of [undefined, null, {}, [], { config: {} }, { envelope: { messages: [] } }, { tools: cyclic }]) {
    assert.equal(estimateProviderToolsTokens(payload), undefined);
    emit("before_provider_request", { payload });
    assert.equal(toolTokens(tracker.getSnapshot()), toolTokens(fallback));
    assert.deepEqual(tracker.getSnapshot().imagesWire, fallback.imagesWire);
    emit("turn_end");
    assert.equal(toolTokens(tracker.getSnapshot()), toolTokens(fallback));
    assert.deepEqual(tracker.getSnapshot().imagesWire, fallback.imagesWire);
  }
  emit("before_provider_request", { payload: { messages: [] } });
  assert.equal(toolTokens(tracker.getSnapshot()), 0);
  assert.equal(tracker.getSnapshot().imagesWire.images, 0);
  emit("before_provider_request", { payload: {} });
  assert.equal(toolTokens(tracker.getSnapshot()), toolTokens(fallback));
  assert.deepEqual(tracker.getSnapshot().imagesWire, fallback.imagesWire);
});

test("known provider envelopes recognize nested tools, images and explicit absence", () => {
  const schema = { ...tool, parameters: { type: "image", inlineData: { mimeType: "image/png" } } };
  const cases = [
    { tools: [schema], messages: [{ content: [{ type: "image", source: { data: "image" } }] }] },
    { tools: [schema], messages: [{ content: [{ type: "image_url", image_url: { url: "image" } }] }] },
    { tools: [schema], input: [{ content: [{ type: "input_image", image_url: "image" }] }] },
    { config: { tools: [schema] }, contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: "image" } }] }] },
    { modelId: "bedrock-model", toolConfig: { tools: [schema] }, messages: [{ content: [{ image: { format: "png", source: { bytes: new Uint8Array([1]) } } }] }] },
  ];
  for (const payload of cases) {
    const { tracker, emit } = trackerForContext();
    emit("before_provider_request", { payload });
    assert.equal(toolTokens(tracker.getSnapshot()), tokens([schema]));
    // Image-like schema fields do not count as transmitted image content.
    assert.deepEqual(tracker.getSnapshot().imagesWire, { images: 1, source: "provider payload" });
    emit("agent_settled");
    assert.deepEqual(tracker.getSnapshot().imagesWire, { images: 1, source: "provider payload" });
  }
  for (const payload of [
    { messages: [] }, { messages: [], tools: [] }, { input: "text only" }, { input: [], tools: [] },
    { contents: [], config: {} }, { contents: [], config: { tools: [] } },
    { contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: "audio" } }] }], config: {} },
    { modelId: "bedrock-model", messages: [] }, { modelId: "bedrock-model", messages: [], toolConfig: { tools: [] } },
  ]) {
    const { tracker, emit } = trackerForContext();
    emit("before_provider_request", { payload });
    assert.equal(toolTokens(tracker.getSnapshot()), 0);
    assert.deepEqual(tracker.getSnapshot().imagesWire, { images: 0, source: "provider payload" });
    emit("turn_end");
    assert.equal(toolTokens(tracker.getSnapshot()), 0);
    assert.deepEqual(tracker.getSnapshot().imagesWire, { images: 0, source: "provider payload" });
  }
});

// Exercise the installed provider converters, then stop inside onPayload before
// any SDK transport can run. No API keys, credentials or model requests are used.
for (const provider of [googleProvider(), amazonBedrockProvider()] as Provider[]) {
  test(`${provider.id} real SDK onPayload tools/images are counted offline`, async () => {
    const model = provider.getModels().find(candidate => candidate.input.includes("image"));
    assert.ok(model, "provider must expose an image-capable test model");
    const stopped = "offline regression: stopped at onPayload";
    for (const populated of [true, false]) {
      const { tracker, emit } = trackerForContext();
      let captured = false;
      const result = await provider.stream(model, normalizeContext({
        messages: populated ? messages : [{ role: "user", content: "text only", timestamp: 1 }],
        tools: populated ? [tool] : [],
      }), {
        apiKey: "offline-placeholder", region: "us-east-1",
        onPayload: (payload: any) => {
          captured = true;
          const providerTools = provider.id === "google" ? payload.config.tools : payload.toolConfig?.tools;
          if (populated) assert.ok(providerTools?.length, "real converter must emit nested tools");
          emit("before_provider_request", { payload });
          assert.equal(toolTokens(tracker.getSnapshot()), populated ? tokens(providerTools) : 0);
          assert.deepEqual(tracker.getSnapshot().imagesWire, { images: populated ? 1 : 0, source: "provider payload" });
          emit("agent_settled");
          assert.equal(toolTokens(tracker.getSnapshot()), populated ? tokens(providerTools) : 0);
          assert.deepEqual(tracker.getSnapshot().imagesWire, { images: populated ? 1 : 0, source: "provider payload" });
          throw new Error(stopped);
        },
      }).result();
      assert.equal(captured, true, result.errorMessage);
      assert.equal(result.stopReason, "error");
      assert.match(result.errorMessage ?? "", new RegExp(stopped));
    }
  });
}
