import { html } from "lit";
import type { SidebarApprovalRowProps } from "./exec-approval-card-solid.tsx";
import "./exec-approval-card-solid.tsx";

export function renderSidebarApprovalRow(props: SidebarApprovalRowProps) {
  return html`<openclaw-sidebar-approval-row .props=${props}></openclaw-sidebar-approval-row>`;
}
