import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { pathForRoute } from "../app-route-paths.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { IdentityAvatarController } from "../lib/identity-avatar-loader.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { projectRosterActivity } from "../lib/reactive/domain-capabilities.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import type { SessionMethodAccess } from "../lib/session-method-access.ts";
import { generateUUID } from "../lib/uuid.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { newSessionSearch } from "../pages/new-session/location.ts";
import type { AgentIdentity } from "./identity-avatar-view.ts";
import { Icon } from "./solid/icon.tsx";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";
import { Menu, type MenuHandle, type MenuItem } from "./solid/menu.tsx";
import "../styles/sidebar-agent-roster.css";

type NewSessionMenuProps = {
  basePath: string;
  triggerClass: string;
  snapshotCards: readonly AgentIdentity[] | null;
  access: SessionMethodAccess;
  active: boolean;
  onOpen: (agentId: string) => void;
  onShow?: () => void;
};

export function NewSessionMenuContent(props: NewSessionMenuProps) {
  const id = `sidebar-new-session-${generateUUID()}`;
  let menu: MenuHandle;
  const context = useOptionalApplication();
  const roster = context ? projectRosterActivity(rosterActivityStore(context)) : undefined;
  const cards = createParkedProjection(
    () => props.snapshotCards ?? roster?.read().cards ?? [],
    () => props.active,
  );
  const [opened, setOpened] = createSignal(false);
  const [revision, refresh] = createSignal(0, { ownedWrite: true });
  const avatars = new IdentityAvatarController(() => refresh((value) => value + 1));
  avatars.hostConnected();
  onCleanup(() => avatars.hostDisconnected());
  const resolvedCards = createMemo(() => {
    revision();
    return avatars.withActiveRoutes(() =>
      opened()
        ? cards().map((card) =>
            Object.assign({}, card, { avatar: card.avatar ? avatars.resolve(card.avatar) : null }),
          )
        : cards(),
    );
  });
  const items = createMemo<MenuItem[]>(() =>
    resolvedCards().map((card) => ({
      id: card.id,
      label: card.name ?? card.id,
      href: `${pathForRoute("new-session", props.basePath)}${newSessionSearch(card.id)}`,
      class: "sidebar-agent-roster__link",
      disabled: !props.access.allowed,
      attributes: { value: card.id },
      icon: (
        <Show when={opened()}>
          <span class="sidebar-agent-roster__avatar" aria-hidden="true">
            <AgentIdentityAvatar agent={card} />
          </span>
        </Show>
      ),
    })),
  );
  return (
    <Menu
      id={id}
      ref={(handle) => (menu = handle)}
      class="sidebar-new-session-menu"
      panelClass="sidebar-new-session-menu__panel"
      triggerClass={props.triggerClass}
      label={t("agentChip.newConversation")}
      trigger={<Icon name="plus" />}
      triggerAttributes={{
        title: props.access.allowed ? t("agentChip.newConversation") : props.access.reason,
      }}
      placement="bottom-end"
      disabled={!props.access.allowed || cards().length === 0}
      items={items()}
      onBeforeShow={() => {
        props.onShow?.();
        setOpened(true);
      }}
      onSelect={(item) => {
        if (props.access.allowed && cards().some((card) => card.id === item.id)) {
          menu.close();
          props.onOpen(item.id);
        }
      }}
    />
  );
}

defineSolidBridge<NewSessionMenuProps>(
  "openclaw-sidebar-new-session-menu",
  (props) => <NewSessionMenuContent {...props} />,
  {
    properties: {
      basePath: { default: "", attribute: false },
      triggerClass: { default: "sidebar-rail__button sidebar-new-session", attribute: false },
      snapshotCards: { default: null, attribute: false },
      access: { default: { allowed: true, requiredScope: "operator.write" }, attribute: false },
      active: { default: true, attribute: false },
      onOpen: { default: () => {}, attribute: false },
      onShow: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-sidebar-new-session-menu": SolidBridgeElement<NewSessionMenuProps>;
  }
}
