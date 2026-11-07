import { nextTick, useId, type Ref, type Directive } from 'vue';
/** Naive 2.45.3 exposes tab-props but has no keyboard/ARIA tab behavior. */
export function useAccessibleTabs(value: Ref<string>, names: () => string[], disabled: () => boolean, sharedPanel = false) {
  const prefix = `tabs-${useId()}`;
  const tabId = (name: string) => `${prefix}-tab-${name}`;
  const panelId = (name: string) => `${prefix}-panel-${sharedPanel ? 'shared' : name}`;
  const tabProps = (name: string) => ({
    id: tabId(name), role: 'tab', tabindex: disabled() ? -1 : value.value === name ? 0 : -1,
    'aria-selected': value.value === name, 'aria-disabled': disabled(), 'aria-controls': panelId(name),
    onKeydown(event: KeyboardEvent) {
      if (disabled() || event.defaultPrevented) return;
      const items = names(); if (!items.length) return;
      let target = name;
      if (event.key === 'ArrowRight') target = items[(items.indexOf(name) + 1) % items.length]!;
      else if (event.key === 'ArrowLeft') target = items[(items.indexOf(name) - 1 + items.length) % items.length]!;
      else if (event.key === 'Home') target = items[0]!;
      else if (event.key === 'End') target = items[items.length - 1]!;
      else if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const element = (event.currentTarget as HTMLElement).ownerDocument.getElementById(tabId(target));
      // Reuse Naive's click pipeline, including disabled/on-before-leave/update:value.
      element?.click();
      void nextTick(() => { if (value.value === target) element?.focus(); });
    },
  });
  const panelProps = (name: string) => ({ id: panelId(name), role: 'tabpanel', 'aria-labelledby': tabId(name) });
  return { tabProps, panelProps };
}

type TablistState = { resize?: ResizeObserver; schedule: () => void; frame?: number };
const tablists = new WeakMap<HTMLElement, TablistState>();
/** Only move the horizontal tab scroller; scrollIntoView can also move the page. */
function revealSelected(element: HTMLElement) {
  const selected = element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  const scroller = element.querySelector<HTMLElement>('.n-tabs-nav-scroll-content')?.parentElement;
  if (!selected || !scroller || scroller.clientWidth === 0) return;
  const tab = selected.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
  if (tab.left < viewport.left) scroller.scrollLeft -= viewport.left - tab.left;
  else if (tab.right > viewport.right) scroller.scrollLeft += tab.right - viewport.right;
}
/** Isolate the version-specific DOM boundary; panes must not be in tablist. */
export const vAccessibleTablist: Directive<HTMLElement, string> = {
  mounted(element, binding) {
    const navigation = element.querySelector('.n-tabs-nav');
    navigation?.setAttribute('role', 'tablist');
    navigation?.setAttribute('aria-label', binding.value);
    const state: TablistState = { schedule() {
      if (state.frame !== undefined) cancelAnimationFrame(state.frame);
      state.frame = requestAnimationFrame(() => { delete state.frame; revealSelected(element); });
    } };
    if (typeof ResizeObserver !== 'undefined') {
      state.resize = new ResizeObserver(state.schedule);
      state.resize.observe(element);
      if (navigation) state.resize.observe(navigation);
    }
    tablists.set(element, state);
    state.schedule();
  },
  updated(element) { tablists.get(element)?.schedule(); },
  beforeUnmount(element) {
    const state = tablists.get(element);
    state?.resize?.disconnect();
    if (state?.frame !== undefined) cancelAnimationFrame(state.frame);
    tablists.delete(element);
  },
};
