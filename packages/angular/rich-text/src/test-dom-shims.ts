/**
 * jsdom implements enough DOM for ProseMirror to mount, but not the layout
 * queries it makes when the selection changes. These no-op shims keep the
 * editor usable in unit tests; a browser needs none of them.
 */
export function installProseMirrorDomShims(): void {
  const rect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  });
  const rects = () => {
    const list = [] as unknown as DOMRectList;
    Object.defineProperty(list, 'item', { value: () => null });
    return list;
  };
  if (typeof Range !== 'undefined') {
    Range.prototype.getBoundingClientRect ??= rect as () => DOMRect;
    Range.prototype.getClientRects ??= rects;
  }
  if (typeof Element !== 'undefined') {
    Element.prototype.getClientRects ??= rects;
    Element.prototype.scrollIntoView ??= () => undefined;
  }
  if (typeof document !== 'undefined' && typeof document.elementFromPoint !== 'function') {
    Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true });
  }
}
