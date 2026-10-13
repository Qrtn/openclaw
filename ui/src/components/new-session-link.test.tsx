import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMethodAccess } from "../lib/session-method-access.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { NewSessionMenuContent } from "./new-session-link.solid.tsx";

afterEach(cleanupSolid);

async function settle() {
  await Promise.resolve();
  flush();
  await Promise.resolve();
  flush();
}

describe("new-session agent menu", () => {
  it("keeps native agent links, uses the current callback, and rejects revoked access", async () => {
    const [access, setAccess] = createSignal<SessionMethodAccess>({
      allowed: true,
      requiredScope: "operator.write",
    });
    const first = vi.fn();
    const current = vi.fn();
    const [onOpen, setOnOpen] = createSignal<(agentId: string) => void>(() => first);
    const view = mountSolid(() => (
      <NewSessionMenuContent
        basePath="/control"
        triggerClass="sidebar-new-session"
        snapshotCards={[
          { id: "writer", name: "Writer" },
          { id: "research", name: "Research" },
        ]}
        access={access()}
        active
        onOpen={onOpen()}
      />
    ));
    await settle();
    const trigger = view.getByRole("button", { name: "New conversation" });
    trigger.click();
    await settle();
    const links = [...view.container.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"]')];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/control/new?agent=writer",
      "/control/new?agent=research",
    ]);
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual(["Writer", "Research"]);
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    let handled = true;
    links[0]!.addEventListener(
      "click",
      (click) => {
        handled = click.defaultPrevented;
        click.preventDefault();
      },
      { once: true },
    );
    links[0]!.dispatchEvent(modified);
    await settle();
    expect(handled).toBe(false);
    expect(first).not.toHaveBeenCalled();
    setOnOpen(() => current);
    flush();
    expect(view.container.querySelector('a[role="menuitem"]')).toBe(links[0]);
    links[0]!.click();
    await settle();
    expect(current).toHaveBeenCalledWith("writer");
    expect(first).not.toHaveBeenCalled();
    trigger.click();
    await settle();
    setAccess({
      allowed: false,
      requiredScope: "operator.write",
      reason: "Access revoked",
      cause: "missing-scope",
    });
    flush();
    links[1]!.click();
    await settle();
    expect(current).toHaveBeenCalledTimes(1);
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.getAttribute("title")).toBe("Access revoked");
  });
});
