import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js";
import {describe, expect, it, vi} from "vitest";
import {presentationCardMetadataKey} from "../../../src/interfaces/mcp-app/card-contract.js";
import {admitPresentationToolResult, type PresentationViewApp} from "../../../src/interfaces/mcp-app/view/lifecycle.js";

const cardId = "A".repeat(43), otherId = Buffer.alloc(32, 1).toString("base64url");
const ack = {kind: "card", cardId, disposition: "created"};
const reference = {kind: "card", cardId};
const link = {type: "resource_link" as const, name: `presentation_card_${cardId}`,
  uri: `littlejohn://presentation/cards/${cardId}`, mimeType: "application/json"};
const text = {type: "text" as const, text: JSON.stringify(ack)};
// The observed Claude carrier is a resource name, colon, space and URI.
// IDs are independent synthetic values; this fixture does not use the adapter.
const claudeLink = {type: "text" as const, text: `presentation_card_${cardId}: ${link.uri}`};
const failure = {ok: false, error: {code: "runtime_state_unavailable", category: "runtime",
  message: "Local runtime state is unavailable.", retryable: false, issues: []}};
const host = (name = "standard") => ({getHostVersion: () => ({name, version: "1"}),
  getHostCapabilities: () => ({serverTools: {}}), callServerTool: vi.fn(async () => {throw new Error("Admission cannot call a tool.");}),
  readServerResource: vi.fn(async () => {throw new Error("Admission cannot read a resource.");})} satisfies PresentationViewApp);
const wrapper = (inner: CallToolResult): CallToolResult => ({content: [{type: "text", text: JSON.stringify(inner)}]});
const admit = (value: CallToolResult, name?: string) => {
  const app = host(name);
  return {app, result: admitPresentationToolResult(app, value, new AbortController().signal)};
};

describe("creating response admission", () => {
  it.each([
    {content: [], structuredContent: ack},
    {content: [text]},
    {content: [link]},
    {content: [], _meta: {[presentationCardMetadataKey]: reference}},
    {content: [text, link], structuredContent: undefined, _meta: undefined, isError: undefined},
    {content: [{type: "text", text: JSON.stringify({disposition: "created", cardId, kind: "card"}, null, 2)}, link],
      structuredContent: ack, _meta: {[presentationCardMetadataKey]: reference}},
  ] satisfies CallToolResult[])("uses admitted identity without requiring duplicate carriers: %#", async value => {
    const test = admit(value);
    expect(await test.result).toEqual({status: "card", card: {cardId}});
    expect(test.app.callServerTool).not.toHaveBeenCalled(); expect(test.app.readServerResource).not.toHaveBeenCalled();
  });

  it("does not canonicalize unrelated Host metadata", async () => {
    const provider: Record<string, unknown> = {counter: 1n, optional: undefined}; provider["self"] = provider;
    expect(await admit({content: [text], _meta: {provider}}).result).toEqual({status: "card", card: {cardId}});
  });

  it("admits the measured flattened Claude link and one Codex envelope", async () => {
    expect(await admit({content: [claudeLink]}, "Claude").result).toEqual({status: "card", card: {cardId}});
    expect(await admit(wrapper({content: [text, link], structuredContent: ack,
      _meta: {[presentationCardMetadataKey]: reference}}), "chatgpt").result).toEqual({status: "card", card: {cardId}});
    await expect(admit(wrapper({content: [text, link]}), "standard").result).rejects.toThrow();
  });

  it("admits the observed Claude link with both ACK copies and card metadata", async () => {
    const test = admit({content: [text, claudeLink], structuredContent: ack,
      _meta: {[presentationCardMetadataKey]: reference}, isError: false}, "Claude");
    expect(await test.result).toEqual({status: "card", card: {cardId}});
    expect(test.app.callServerTool).not.toHaveBeenCalled(); expect(test.app.readServerResource).not.toHaveBeenCalled();
  });

  it("checks the flattened name against its URI before any other identity is available", async () => {
    const test = admit({content: [{type: "text", text: `presentation_card_${otherId}: ${link.uri}`}]}, "Claude");
    await expect(test.result).rejects.toThrow("Card link name and URI differ");
    expect(test.app.callServerTool).not.toHaveBeenCalled(); expect(test.app.readServerResource).not.toHaveBeenCalled();
  });

  it.each([
    {content: [claudeLink], structuredContent: {...ack, cardId: otherId}},
    {content: [claudeLink], _meta: {[presentationCardMetadataKey]: {kind: "card", cardId: otherId}}},
  ])("compares the admitted Claude link with each other supplied identity: %#", async value => {
    await expect(admit(value, "Claude").result).rejects.toThrow("Creation acknowledgement differs from its card");
  });

  it.each([
    `presentation_card_${cardId}: littlejohn://other/${cardId}`,
    `presentation_card_${cardId}: ${link.uri} extra`,
    `presentation_card_${cardId}: ${link.uri}\n`,
    `[Resource link: presentation_card_${cardId}] ${link.uri} (Saved state of this exact card.)`,
  ])("rejects altered and obsolete flattened forms: %#", async value => {
    await expect(admit({content: [{type: "text", text: value}]}, "Claude").result).rejects.toThrow();
  });

  it("does not turn unrelated text or another Host into a Claude card reference", async () => {
    await expect(admit({content: [claudeLink]}, "standard").result).rejects.toThrow("invalid acknowledgement text");
    await expect(admit({content: [text, claudeLink, {type: "text", text: "An unrelated explanation."}],
      structuredContent: ack}, "Claude").result).rejects.toThrow("invalid acknowledgement text");
  });

  it.each([
    {content: [text], structuredContent: {kind: "card", cardId, disposition: "existing"}},
    {content: [text, link], _meta: {[presentationCardMetadataKey]: {kind: "card", cardId: otherId}}},
    {content: [link], structuredContent: null},
    {content: [link], _meta: {[presentationCardMetadataKey]: null}},
    {content: [link], structuredContent: {kind: "card", cardId}},
    {content: [{type: "text", text: '{"kind":"card"'}, link]},
    {content: [{...link, name: `presentation_card_${otherId}`}]},
    {content: [{...link, mimeType: "text/plain"}]},
    {content: [link, link]},
    {content: [], isError: false, structuredContent: failure},
  ])("rejects malformed or conflicting supplied facts without a read: %#", async value => {
    const test = admit(value as CallToolResult);
    await expect(test.result).rejects.toThrow();
    expect(test.app.callServerTool).not.toHaveBeenCalled(); expect(test.app.readServerResource).not.toHaveBeenCalled();
  });

  it("checks structured ACK copies inside and outside the permitted envelope", async () => {
    const inner = {content: [text, link], structuredContent: ack};
    expect(await admit({...wrapper(inner), structuredContent: ack}, "chatgpt").result).toEqual({status: "card", card: {cardId}});
    await expect(admit({...wrapper(inner), structuredContent: {...ack, disposition: "existing"}}, "chatgpt").result)
      .rejects.toThrow("Creating result copies differ");
  });

  it("checks metadata identity in both envelopes even without any ACK", async () => {
    const inner = {content: [], _meta: {[presentationCardMetadataKey]: reference}};
    expect(await admit({...wrapper(inner), _meta: {[presentationCardMetadataKey]: reference}}, "chatgpt").result)
      .toEqual({status: "card", card: {cardId}});
    await expect(admit({...wrapper(inner), _meta: {[presentationCardMetadataKey]: {kind: "card", cardId: otherId}}}, "chatgpt").result)
      .rejects.toThrow("Creation acknowledgement differs from its card");
  });

  it("checks error flags before classifying the same independently valid failure", async () => {
    const inner = {content: [{type: "text" as const, text: JSON.stringify(failure)}], structuredContent: failure, isError: true};
    expect(await admit({...wrapper(inner), isError: true}, "chatgpt").result)
      .toEqual({status: "tool_error", message: failure.error.message, failure});
    await expect(admit({...wrapper(inner), isError: false}, "chatgpt").result).rejects.toThrow("Creating error flags differ");
    await expect(admit({content: [text], structuredContent: ack, isError: true}).result).rejects.toThrow("successful acknowledgement");
  });

  it("rejects nested, mixed and malformed wrappers", async () => {
    for (const value of [wrapper(wrapper({content: [text]})),
      {content: [...wrapper({content: [text]}).content, link]},
      wrapper({content: [{type: "unknown"}] as unknown as CallToolResult["content"]})]) {
      await expect(admit(value, "chatgpt").result).rejects.toThrow();
    }
  });

  it("normalizes optional undefined only for the existing outer missing-error form", async () => {
    const canonicalText = '{"error":{"category":"runtime","code":"runtime_state_unavailable","issues":[],"message":"Local runtime state is unavailable.","retryable":false},"ok":false}';
    const value = {content: [{type: "text" as const, text: canonicalText}], structuredContent: failure, _meta: undefined, isError: undefined};
    expect(await admit(value, "chatgpt").result).toEqual({status: "tool_error", message: failure.error.message, failure});
    await expect(admit({...value, _meta: {}}, "chatgpt").result).rejects.toThrow();
    await expect(admit(wrapper({content: value.content, structuredContent: failure}), "chatgpt").result).rejects.toThrow();
    expect(await admit({content: value.content, isError: true}, "Claude").result).toEqual({status: "tool_error",
      message: "The tool call ended with an error before a displayable result was available."});
  });
});
