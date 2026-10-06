// @vitest-environment happy-dom
/* AC tests for issue #576 — Esc closes things, it never stops an employee's
   work. A mount-ordered UI-layer stack decides which surface owns the press
   (menu → dialog → panel → Focus); ■ / ⌘. is the real stop shortcut. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { composerKeyDown } from "../src/chat/composer-keys";
import { useUiLayer, useUiLayerEl } from "../src/chat/ui-layers";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const esc = () => {
  document.body.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
};

function PlainLayer({ onEscape }: { onEscape: () => void }) {
  useUiLayer({ onEscape });
  return <div />;
}

function DialogLayer({
  onEscape,
  label,
}: {
  onEscape: () => void;
  label: string;
}) {
  const ref = useUiLayerEl<HTMLDivElement>({ onEscape });
  return (
    <div className="fixed inset-0">
      <div role="dialog" aria-modal="true" aria-label={label} ref={ref} />
    </div>
  );
}

describe("issue #576 Esc layer stack", () => {
  test("AC-576-1 Esc reaches only the top-most layer — dialog over panel closes alone", () => {
    const panel = vi.fn();
    const dialog = vi.fn();
    render(
      <>
        <PlainLayer onEscape={panel} />
        <DialogLayer onEscape={dialog} label="Hire an employee" />
      </>,
    );
    esc();
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(panel).not.toHaveBeenCalled();
    cleanup();
    const panel2 = vi.fn();
    render(<PlainLayer onEscape={panel2} />);
    esc();
    expect(panel2).toHaveBeenCalledTimes(1);
  });

  test("AC-576-2 a registered dialog's role=dialog root is not a foreign overlay", () => {
    // Without el registration the layer's own [role=dialog] would read as an
    // open overlay and swallow its own Esc (dialogs could never close).
    const dialog = vi.fn();
    render(<DialogLayer onEscape={dialog} label="Add a folder" />);
    esc();
    esc();
    expect(dialog).toHaveBeenCalledTimes(2);
  });

  test("AC-576-3 an open popover/menu owns Esc — the layer under it stays put", () => {
    const onEscape = vi.fn();
    render(<PlainLayer onEscape={onEscape} />);
    const pop = document.createElement("div");
    pop.setAttribute("data-slot", "popover-content");
    pop.setAttribute("data-open", "");
    document.body.appendChild(pop);
    esc();
    expect(onEscape).not.toHaveBeenCalled();
    pop.remove();
    esc();
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  test("AC-576-4 a role'd overlay not in the stack (vendored dialog) owns Esc", () => {
    const onEscape = vi.fn();
    render(<PlainLayer onEscape={onEscape} />);
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    document.body.appendChild(dlg);
    esc();
    expect(onEscape).not.toHaveBeenCalled();
    dlg.remove();
    esc();
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  test("AC-576-5 Esc in the composer NEVER stops the turn — ⌘. does", () => {
    const onStop = vi.fn();
    const el = document.createElement("textarea");
    const handler = composerKeyDown({
      running: true,
      onStop,
      setDraft: () => {},
    });
    // Esc with a running turn: inert now (it only closes things).
    handler({
      key: "Escape",
      nativeEvent: { isComposing: false },
      preventDefault: () => {},
      currentTarget: el,
    } as never);
    expect(onStop).not.toHaveBeenCalled();
    // ⌘. is the real stop shortcut (same handler as ■).
    const prevented = vi.fn();
    handler({
      key: ".",
      metaKey: true,
      nativeEvent: { isComposing: false },
      preventDefault: prevented,
      currentTarget: el,
    } as never);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(prevented).toHaveBeenCalled();
  });

  test("AC-576-6 Esc still dismisses the composer's own overlay before anything else", () => {
    const onStop = vi.fn();
    const onDismiss = vi.fn();
    const el = document.createElement("textarea");
    const handler = composerKeyDown({
      running: true,
      onStop,
      setDraft: () => {},
      onDismissOverlay: onDismiss,
    });
    handler({
      key: "Escape",
      nativeEvent: { isComposing: false },
      preventDefault: () => {},
      currentTarget: el,
    } as never);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });
});
