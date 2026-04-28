from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .graph import RailwayGraph
from .train import Train


REROUTE_COOLDOWN_TICKS = 8


@dataclass
class AgentDecision:
    decision: str
    source: str
    train_id: str
    reason: str
    old_route: list[str]
    new_route: list[str] | None
    delay_before: int
    delay_after: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "decision": self.decision,
            "source": self.source,
            "train_id": self.train_id,
            "reason": self.reason,
            "old_route": self.old_route,
            "new_route": self.new_route,
            "delay_before": self.delay_before,
            "delay_after": self.delay_after,
        }


class SafeRailAgent:
    def __init__(self, model_path: str | Path):
        self.model_path = Path(model_path)
        self.model: Any | None = None
        self.model_available = False
        self.load_error: str | None = None
        self._try_load_model()

    def _try_load_model(self) -> None:
        if not self.model_path.exists():
            self.load_error = "PPO model not found. Heuristic controller is active."
            return
        try:
            from stable_baselines3 import PPO

            self.model = PPO.load(str(self.model_path))
            self.model_available = True
            self.load_error = None
        except Exception as exc:
            self.model = None
            self.model_available = False
            self.load_error = str(exc)

    def safe_decision(
        self,
        graph: RailwayGraph,
        trains: dict[str, Train],
        occupancy: dict[str, int],
        tick: int,
    ) -> AgentDecision | None:
        try:
            if self.model_available:
                decision = self._ppo_decision(graph, trains, occupancy, tick)
                source = "ppo"
            else:
                decision = self._heuristic_decision(graph, trains, occupancy, tick)
                source = "heuristic"
        except Exception:
            decision = self._heuristic_decision(graph, trains, occupancy, tick)
            source = "heuristic"

        if decision is None:
            return None
        decision.source = source
        if not self._valid(decision):
            return None
        if not self._beneficial(decision):
            return None
        return decision

    def _ppo_decision(
        self,
        graph: RailwayGraph,
        trains: dict[str, Train],
        occupancy: dict[str, int],
        tick: int,
    ) -> AgentDecision | None:
        # The runtime accepts PPO when a trained model exists, but V1 keeps
        # action interpretation conservative by validating through the same
        # heuristic gate used by the fallback controller.
        return self._heuristic_decision(graph, trains, occupancy, tick)

    def _heuristic_decision(
        self,
        graph: RailwayGraph,
        trains: dict[str, Train],
        occupancy: dict[str, int],
        tick: int,
    ) -> AgentDecision | None:
        candidates = sorted(
            trains.values(),
            key=lambda train: (-train.priority, -train.delay, train.id),
        )

        for train in candidates:
            if train.complete or train.status == "scheduled":
                continue
            if tick - train.last_reroute_tick < REROUTE_COOLDOWN_TICKS:
                continue

            start_node = train.next_node if train.on_edge else train.current_node
            if start_node is None:
                continue

            route_tail = self._current_route_tail(train, start_node)
            if not route_tail:
                continue

            risky_edges = self._risky_edges(graph, route_tail, occupancy)
            if not risky_edges and train.delay < 8:
                continue

            new_path = graph.dijkstra(start_node, train.destination, occupancy)
            if not new_path:
                return AgentDecision(
                    decision="hold",
                    source="heuristic",
                    train_id=train.id,
                    reason="route_unavailable",
                    old_route=route_tail,
                    new_route=None,
                    delay_before=train.delay,
                    delay_after=train.delay + 5,
                )

            if new_path == route_tail:
                continue

            before_minutes = graph.total_route_minutes(route_tail, occupancy)
            after_minutes = graph.total_route_minutes(new_path, occupancy)
            if after_minutes >= before_minutes and not risky_edges:
                continue

            if before_minutes == float("inf"):
                projected_before = train.delay + 999
            else:
                projected_before = int(round(train.delay + before_minutes))
            projected_after = int(round(train.delay + after_minutes))
            return AgentDecision(
                decision="reroute",
                source="heuristic",
                train_id=train.id,
                reason="high_congestion" if risky_edges else "delay_threshold",
                old_route=route_tail,
                new_route=new_path,
                delay_before=projected_before,
                delay_after=projected_after,
            )

        stop_decision = self._lower_priority_stop_decision(graph, trains, occupancy)
        if stop_decision:
            return stop_decision
        return None

    def _current_route_tail(self, train: Train, start_node: str) -> list[str]:
        if start_node in train.route:
            start_index = train.route.index(start_node)
            return train.route[start_index:]
        return [start_node, train.destination]

    def _risky_edges(
        self,
        graph: RailwayGraph,
        route: list[str],
        occupancy: dict[str, int],
    ) -> list[str]:
        risky: list[str] = []
        for edge_id in graph.route_edges(route):
            edge = graph.edges[edge_id]
            load_ratio = occupancy.get(edge_id, 0) / max(1, edge.capacity)
            if edge.blocked or load_ratio > 1.0:
                risky.append(edge_id)
        return risky

    def _lower_priority_stop_decision(
        self,
        graph: RailwayGraph,
        trains: dict[str, Train],
        occupancy: dict[str, int],
    ) -> AgentDecision | None:
        for edge_id, count in occupancy.items():
            edge = graph.edges.get(edge_id)
            if edge is None or count <= edge.capacity:
                continue
            trains_on_edge = [
                train
                for train in trains.values()
                if train.edge_id == edge_id and train.status == "moving" and train.priority <= 2
            ]
            if not trains_on_edge:
                continue
            target = sorted(trains_on_edge, key=lambda train: (train.priority, -train.delay, train.id))[0]
            return AgentDecision(
                decision="stop",
                source="heuristic",
                train_id=target.id,
                reason="capacity_relief",
                old_route=target.route,
                new_route=None,
                delay_before=target.delay,
                delay_after=target.delay + 1,
            )
        return None

    def _valid(self, decision: AgentDecision) -> bool:
        if decision.decision == "reroute":
            return bool(decision.new_route) and decision.new_route != decision.old_route
        return decision.decision in {"hold", "stop", "resume"}

    def _beneficial(self, decision: AgentDecision) -> bool:
        if decision.decision == "reroute":
            return decision.delay_after < decision.delay_before
        if decision.decision in {"hold", "stop"}:
            return decision.reason in {"route_unavailable", "capacity_relief"}
        return True
