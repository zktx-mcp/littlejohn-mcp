const unsafeCssSyntax =
  /@(?:font-face|import)\b|\b(?:image|image-set|url)\s*\(|(?:https?:)?\/\/|\bdata:|\b(?:-moz-)?binding\s*:/iu;

export const browserAssetContentViolation = (
  name: string,
  body: string,
): "unsupported_asset_content" | "unsafe_css_syntax" | undefined => {
  if (body.includes("\0") || /sourceMappingURL/iu.test(body)) {
    return "unsupported_asset_content";
  }
  if (name.endsWith(".css") && (
    body.includes("\\") || body.includes("/*") || body.includes("*/") || unsafeCssSyntax.test(body)
  )) return "unsafe_css_syntax";
  return undefined;
};
