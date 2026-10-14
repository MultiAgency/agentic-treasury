import { Link, useLocation } from "@tanstack/react-router";
import { useGateway } from "./gateway-context";
import { Workspace } from "./workspace";
import { AgentTaskBoundary } from "./agent-task-boundary";

/** Navigation does not wait for provider-dependent task observations. */
export function Shell() {
  const gateway = useGateway();
  const pathname = useLocation({ select: location => location.pathname });
  return gateway ? <Workspace gateway={gateway} pathname={pathname} taskLink={(task, className, close) =>
    <Link to={task.to} activeOptions={{ exact: true }} className={className} onClick={close}>{task.label}</Link>
  }><AgentTaskBoundary /></Workspace> : <AgentTaskBoundary />;
}
