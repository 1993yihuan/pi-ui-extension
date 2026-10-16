import { HStack, type Component } from "@earendil-works/pi-tui";

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

/** Only extension-owned panels opt in; no host components or prototypes change. */
export function createSidebarRenderCache() {
  const caches = new Set<Map<number, string[]>>();
  return {
    beginFrame(): void { for (const cache of caches) cache.clear(); },
    cacheRender(component: Component): void {
      const render = component.render;
      const cache = new Map<number, string[]>();
      caches.add(cache);
      component.render = function (width) {
        let lines = cache.get(width);
        if (!lines) {
          lines = render.call(this, width);
          cache.set(width, lines);
        }
        return lines;
      };
    },
  };
}

/** The root is visited once per layout frame, before any intrinsic measurements. */
export class SidebarLayoutRoot extends HStack {
  constructor(children: ConstructorParameters<typeof HStack>[0], private readonly beginFrame: () => void) {
    super(children);
  }

  override render(width: number): string[] {
    this.beginFrame();
    return super.render(width);
  }

  [LAYOUT_NODE]() {
    this.beginFrame();
    return { type: "hstack" as const, entries: this.entries, gap: this.gap, align: this.align };
  }
}
