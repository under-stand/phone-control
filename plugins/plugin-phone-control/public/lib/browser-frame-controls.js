function positiveNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be positive`);
  return value;
}

export function containedImageRect(elementRect, intrinsicWidth, intrinsicHeight) {
  const width = positiveNumber(elementRect?.width, "elementRect.width");
  const height = positiveNumber(elementRect?.height, "elementRect.height");
  const imageWidth = positiveNumber(intrinsicWidth, "intrinsicWidth");
  const imageHeight = positiveNumber(intrinsicHeight, "intrinsicHeight");
  const scale = Math.min(width / imageWidth, height / imageHeight);
  const renderedWidth = imageWidth * scale;
  const renderedHeight = imageHeight * scale;
  return {
    left: Number(elementRect.left || 0) + (width - renderedWidth) / 2,
    top: Number(elementRect.top || 0) + (height - renderedHeight) / 2,
    width: renderedWidth,
    height: renderedHeight,
  };
}

export function mapPointerToViewport({
  clientX,
  clientY,
  elementRect,
  intrinsicWidth,
  intrinsicHeight,
  viewportWidth,
  viewportHeight,
}) {
  const content = containedImageRect(elementRect, intrinsicWidth, intrinsicHeight);
  const x = clientX - content.left;
  const y = clientY - content.top;
  if (x < 0 || y < 0 || x > content.width || y > content.height) return null;
  return {
    x: Math.min(viewportWidth - 0.001, Math.max(0, x / content.width * viewportWidth)),
    y: Math.min(viewportHeight - 0.001, Math.max(0, y / content.height * viewportHeight)),
  };
}
