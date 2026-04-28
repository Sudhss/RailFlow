from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from .agent import REROUTE_COOLDOWN_TICKS, AgentDecision, SafeRailAgent
from .graph import Edge, RailwayGraph
from .incidents import IncidentRegistry
from .logs import LogBook
from .train import Train, profile_for_train_type


SIM_TICK_MINUTES = 1


class SimulationError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class RailFlowSimulation:
    def __init__(self, graph_path: str | Path, model_path: str | Path):
        self.graph_path = Path(graph_path)
        self.graph = RailwayGraph(self.graph_path)
        self.agent = SafeRailAgent(model_path)
        self.logs = LogBook()
        self.incidents = IncidentRegistry()
        self.trains: dict[str, Train] = {}
        self.tick = 0
        self.paused = True
        self.emergency_halt_active = False
        self.tick_interval_seconds = 1.0
        self.last_agent_decision: dict[str, Any] | None = None
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="system",
            severity="info",
            message="RailFlow simulation initialized.",
        )

    @property
    def sim_start_minutes(self) -> int:
        hour, minute = self.graph.sim_start.split(":")
        return int(hour) * 60 + int(minute)

    @property
    def sim_time(self) -> str:
        total_minutes = (self.sim_start_minutes + self.tick * SIM_TICK_MINUTES) % (24 * 60)
        hour = total_minutes // 60
        minute = total_minutes % 60
        return f"{hour:02d}:{minute:02d}"

    def reset(self) -> None:
        self.graph.reset()
        self.trains.clear()
        self.incidents.clear()
        self.logs.clear()
        self.tick = 0
        self.paused = True
        self.emergency_halt_active = False
        self.last_agent_decision = None
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="reset",
            severity="info",
            message="Simulation reset to the base railway graph.",
        )

    def seed_scenario(self, scenario: str = "mixed_peak") -> None:
        self.reset()
        scenario = scenario or "mixed_peak"
        seeds = self._scenario_trains(scenario)
        for payload in seeds:
            self.add_train(payload)
        for incident in self._scenario_incidents(scenario):
            self.add_incident(incident)
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="seed",
            severity="info",
            message=f"Seed scenario loaded: {scenario}.",
            details={"scenario": scenario},
        )

    def set_paused(self, paused: bool) -> None:
        self.paused = paused
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="simulation",
            severity="info",
            message="Simulation paused." if paused else "Simulation resumed.",
        )

    def set_tick_interval(self, seconds: float) -> None:
        self.tick_interval_seconds = min(5.0, max(0.2, float(seconds)))
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="simulation",
            severity="info",
            message=f"Tick interval set to {self.tick_interval_seconds:.1f} seconds.",
        )

    def emergency_halt(self, active: bool = True) -> None:
        self.emergency_halt_active = active
        if active:
            for train in self.trains.values():
                if train.status != "arrived":
                    train.stop()
            self.logs.add(
                tick=self.tick,
                sim_time=self.sim_time,
                type="emergency_halt",
                severity="critical",
                message="Emergency halt activated. All trains stopped immediately.",
            )
        else:
            self.logs.add(
                tick=self.tick,
                sim_time=self.sim_time,
                type="emergency_halt",
                severity="info",
                message="Emergency halt released. Dispatchers may resume trains.",
            )

    def corridor_halt(self, edge_ids: list[str]) -> None:
        target_edges = set(edge_ids)
        for train in self.trains.values():
            if train.edge_id in target_edges or self._route_intersects(train.route, target_edges):
                train.stop()
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="corridor_halt",
            severity="critical",
            message="Corridor halt applied.",
            details={"edge_ids": edge_ids},
        )

    def add_train(self, payload: dict[str, Any]) -> Train:
        train_id = payload["id"]
        if train_id in self.trains:
            raise SimulationError(f"Duplicate train id: {train_id}", status_code=409)

        train_type = payload.get("type", "express")
        profile = profile_for_train_type(train_type)
        source = payload["source"]
        destination = payload["destination"]
        if source not in self.graph.stations or destination not in self.graph.stations:
            raise SimulationError("Train source and destination must be valid station ids.")

        route = payload.get("route")
        if route:
            valid, reason = self.graph.validate_route(route, {source}, destination)
            if not valid:
                self.logs.add(
                    tick=self.tick,
                    sim_time=self.sim_time,
                    type="invalid_route",
                    severity="warning",
                    message=f"Train {train_id} rejected because manual route is invalid.",
                    train_id=train_id,
                    details={"reason": reason, "route": route},
                )
                raise SimulationError(reason)
        else:
            route = self.graph.dijkstra(source, destination, self.occupancy())

        if not route:
            self.logs.add(
                tick=self.tick,
                sim_time=self.sim_time,
                type="route_unavailable",
                severity="critical",
                message=f"No available route for {train_id}. Train was not added.",
                train_id=train_id,
                details={"source": source, "destination": destination},
            )
            raise SimulationError("No available route between source and destination.")

        priority = int(payload.get("priority", profile["priority"]))
        max_speed = float(payload.get("max_speed", profile["max_speed"]))
        train = Train(
            id=train_id,
            name=payload.get("name", train_id),
            type=train_type,
            priority=priority,
            source=source,
            destination=destination,
            route=route,
            scheduled_departure_tick=int(payload.get("scheduled_departure_tick", self.tick)),
            max_speed=max_speed,
            current_node=source,
        )
        self.trains[train.id] = train
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="train_added",
            severity="info",
            message=f"{train.id} added from {source} to {destination}.",
            train_id=train.id,
            details={"route": route, "type": train.type, "priority": train.priority},
        )
        return train

    def stop_train(self, train_id: str, reason: str = "manual_stop") -> Train:
        train = self._require_train(train_id)
        train.stop()
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="train_stop",
            severity="warning",
            message=f"{train.id} stopped.",
            train_id=train.id,
            details={"reason": reason},
        )
        return train

    def resume_train(self, train_id: str) -> Train:
        train = self._require_train(train_id)
        if self.emergency_halt_active:
            raise SimulationError("Cannot resume trains while emergency halt is active.")
        train.resume()
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="train_resume",
            severity="info",
            message=f"{train.id} resumed.",
            train_id=train.id,
        )
        return train

    def reroute_train(self, train_id: str) -> Train:
        train = self._require_train(train_id)
        self._reroute_train(train, source="manual", forced=True)
        return train

    def set_manual_route(self, train_id: str, route: list[str]) -> Train:
        train = self._require_train(train_id)
        valid, reason = self.graph.validate_route(route, train.allowed_route_starts(), train.destination)
        if not valid:
            self.logs.add(
                tick=self.tick,
                sim_time=self.sim_time,
                type="invalid_route",
                severity="warning",
                message=f"Manual route rejected for {train.id}.",
                train_id=train.id,
                details={"reason": reason, "route": route},
            )
            raise SimulationError(reason)
        self._assign_route(train, route, source="manual", reason="dispatcher_selected_route")
        return train

    def add_track(self, payload: dict[str, Any]) -> dict[str, Any]:
        edge, created = self.graph.add_or_update_edge(payload)
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="track_add" if created else "track_update",
            severity="info",
            message=f"Track {edge.id} {'added' if created else 'updated'}.",
            edge_id=edge.id,
        )
        return self.graph.edge_snapshot(edge, self.occupancy().get(edge.id, 0))

    def remove_track(self, edge_id: str) -> None:
        edge = self._require_edge(edge_id)
        if self.occupancy().get(edge.id, 0) > 0:
            edge.blocked = True
            self.logs.add(
                tick=self.tick,
                sim_time=self.sim_time,
                type="track_blocked",
                severity="critical",
                message=f"Track {edge.id} is active, so removal became a block.",
                edge_id=edge.id,
            )
            return
        self.graph.delete_edge(edge.id)
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="track_removed",
            severity="warning",
            message=f"Track {edge.id} removed from runtime graph.",
            edge_id=edge.id,
        )

    def close_track(self, edge_id: str) -> Edge:
        edge = self.graph.set_blocked(edge_id, True)
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="track_closed",
            severity="critical",
            message=f"Track {edge.id} closed.",
            edge_id=edge.id,
        )
        return edge

    def reopen_track(self, edge_id: str) -> Edge:
        edge = self.graph.set_blocked(edge_id, False)
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="track_reopened",
            severity="info",
            message=f"Track {edge.id} reopened.",
            edge_id=edge.id,
        )
        self.optimize_active_routes(reason="track_reopened")
        return edge

    def restrict_track_speed(self, edge_id: str, speed_limit: float | None) -> Edge:
        edge = self.graph.set_speed_limit(edge_id, speed_limit)
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="speed_restriction",
            severity="warning" if speed_limit else "info",
            message=f"Track {edge.id} speed limit {'set' if speed_limit else 'cleared'}.",
            edge_id=edge.id,
            details={"speed_limit": speed_limit},
        )
        if speed_limit is None:
            self.optimize_active_routes(reason="speed_restriction_cleared")
        return edge

    def add_incident(self, payload: dict[str, Any]) -> dict[str, Any]:
        edge = self._require_edge(payload["edge_id"])
        incident = self.incidents.add(
            type=payload["type"],
            edge_id=edge.id,
            severity=payload.get("severity", "warning"),
            created_tick=self.tick,
            speed_limit=payload.get("speed_limit"),
            note=payload.get("note", ""),
        )
        if incident.type in {"track_closure", "signal_failure", "maintenance_block"}:
            edge.blocked = True
        if incident.type in {"speed_restriction", "weather_slowdown"} and incident.speed_limit:
            edge.speed_limit = incident.speed_limit
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="incident_added",
            severity=incident.severity,
            message=f"Incident {incident.id} added on {edge.id}.",
            edge_id=edge.id,
            details=incident.to_dict(),
        )
        return incident.to_dict()

    def resolve_incident(self, incident_id: str) -> dict[str, Any]:
        incident = self.incidents.resolve(incident_id)
        if incident is None:
            raise SimulationError(f"Unknown incident id: {incident_id}", status_code=404)

        active_on_edge = self.incidents.active_for_edge(incident.edge_id)
        edge = self.graph.get_edge_by_id(incident.edge_id)
        if edge and not any(item.type in {"track_closure", "signal_failure", "maintenance_block"} for item in active_on_edge):
            edge.blocked = False
        if edge and not any(item.type in {"speed_restriction", "weather_slowdown"} for item in active_on_edge):
            edge.speed_limit = None

        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="incident_resolved",
            severity="info",
            message=f"Incident {incident.id} resolved.",
            edge_id=incident.edge_id,
        )
        self.optimize_active_routes(reason="incident_resolved")
        return incident.to_dict()

    def optimize_active_routes(self, reason: str = "network_optimized") -> int:
        optimized = 0
        for train in list(self.trains.values()):
            if train.status == "arrived":
                continue
            if self._optimize_train_route(train, reason):
                optimized += 1
        if optimized:
            self.logs.add(
                tick=self.tick,
                sim_time=self.sim_time,
                type="network_optimized",
                severity="info",
                message=f"{optimized} active train route optimized after network change.",
                details={"reason": reason, "count": optimized},
            )
        return optimized

    def advance_tick(self) -> None:
        if self.paused:
            return

        self.tick += SIM_TICK_MINUTES
        if self.emergency_halt_active:
            for train in self.trains.values():
                if train.status != "arrived":
                    train.stop()
                    train.delay += 1
            return

        for train in list(self.trains.values()):
            self._advance_train(train)

        self._run_agent_once()

    def occupancy(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for train in self.trains.values():
            if train.edge_id and train.status in {"moving", "stopped"}:
                counts[train.edge_id] = counts.get(train.edge_id, 0) + 1
        return counts

    def snapshot(self) -> dict[str, Any]:
        occupancy = self.occupancy()
        return {
            "simulation": {
                "tick": self.tick,
                "sim_time": self.sim_time,
                "paused": self.paused,
                "emergency_halt_active": self.emergency_halt_active,
                "tick_interval_seconds": self.tick_interval_seconds,
                "sim_tick_minutes": SIM_TICK_MINUTES,
                "agent_source": "ppo" if self.agent.model_available else "heuristic",
                "agent_model_error": self.agent.load_error,
                "reroute_cooldown_ticks": REROUTE_COOLDOWN_TICKS,
            },
            "graph": self.graph.snapshot(occupancy),
            "trains": [train.to_dict() for train in self.trains.values()],
            "incidents": self.incidents.all(),
            "logs_latest": self.logs.latest(30),
            "last_agent_decision": self.last_agent_decision,
        }

    def _advance_train(self, train: Train) -> None:
        if train.status == "arrived":
            return

        if train.status == "scheduled":
            if self.tick >= train.scheduled_departure_tick:
                train.start()
                self._prepare_next_edge(train)
                self.logs.add(
                    tick=self.tick,
                    sim_time=self.sim_time,
                    type="train_departed",
                    severity="info",
                    message=f"{train.id} departed.",
                    train_id=train.id,
                )
            return

        if train.status == "stopped":
            train.delay += 1
            train.current_speed = 0
            return

        if train.status == "dwelling":
            train.dwell_remaining = max(0, train.dwell_remaining - SIM_TICK_MINUTES)
            train.current_speed = 0
            if train.dwell_remaining == 0:
                self._prepare_next_edge(train)
            return

        if train.status == "moving":
            self._move_train_on_edge(train)

    def _prepare_next_edge(self, train: Train) -> None:
        if train.route_index >= len(train.route) - 1:
            train.status = "arrived"
            train.current_speed = 0
            train.completed_tick = self.tick
            self.logs.add(
                tick=self.tick,
                sim_time=self.sim_time,
                type="train_arrived",
                severity="info",
                message=f"{train.id} arrived at {train.destination}.",
                train_id=train.id,
            )
            return

        from_node = train.route[train.route_index]
        to_node = train.route[train.route_index + 1]
        edge = self.graph.get_edge(from_node, to_node)
        if edge is None or edge.blocked:
            self._handle_route_unavailable(train, from_node)
            return

        train.current_node = from_node
        train.next_node = to_node
        train.edge_id = edge.id
        train.edge_progress = 0.0
        train.status = "moving"

    def _move_train_on_edge(self, train: Train) -> None:
        if not train.edge_id or not train.next_node:
            self._prepare_next_edge(train)
            return

        edge = self.graph.get_edge_by_id(train.edge_id)
        if edge is None or edge.blocked:
            train.stop()
            train.hold_at = train.next_node
            train.delay += 1
            self.logs.add(
                tick=self.tick,
                sim_time=self.sim_time,
                type="route_unavailable",
                severity="critical",
                message=f"{train.id} stopped because its active track is blocked.",
                train_id=train.id,
                edge_id=train.edge_id,
                details={"hold_at": train.hold_at},
            )
            return

        occupancy = self.occupancy()
        load_ratio = occupancy.get(edge.id, 0) / max(1, edge.capacity)
        speed = min(train.max_speed, edge.effective_speed_limit)
        if load_ratio > 1:
            speed *= 1 / load_ratio
            train.delay += max(1, math.ceil(load_ratio - 1))
        elif load_ratio >= 0.7:
            speed *= 0.85

        train.current_speed = round(max(0.0, speed), 2)
        distance_this_tick = train.current_speed / 60.0 * SIM_TICK_MINUTES
        train.edge_progress += distance_this_tick / edge.distance_km

        if train.edge_progress >= 1.0:
            self._arrive_at_next_station(train)

    def _arrive_at_next_station(self, train: Train) -> None:
        arrived_node = train.next_node
        if arrived_node is None:
            return

        train.current_node = arrived_node
        train.next_node = None
        train.edge_id = None
        train.edge_progress = 0.0
        train.current_speed = 0.0

        if train.pending_reroute and train.requested_route:
            if train.requested_route[0] == arrived_node:
                train.apply_route_from_node(train.requested_route, self.tick)
                self._prepare_next_edge(train)
                self.logs.add(
                    tick=self.tick,
                    sim_time=self.sim_time,
                    type="reroute_applied",
                    severity="info",
                    message=f"Pending reroute applied for {train.id}.",
                    train_id=train.id,
                    details={"route": train.route},
                )
                return
            train.pending_reroute = False
            train.requested_route = None

        if arrived_node in train.route:
            train.route_index = train.route.index(arrived_node)
        else:
            train.route_index += 1

        if arrived_node == train.destination:
            self._prepare_next_edge(train)
            return

        dwell = self._dwell_for(train, arrived_node)
        if dwell > 0:
            train.dwell_remaining = dwell
            train.status = "dwelling"
        else:
            self._prepare_next_edge(train)

    def _dwell_for(self, train: Train, station_id: str) -> int:
        station = self.graph.stations[station_id]
        profile = profile_for_train_type(train.type)
        if station.type == "minor" and not profile["minor_stop"]:
            return 0
        dwell = station.dwell_base * profile["dwell_multiplier"]
        return max(1, int(round(dwell)))

    def _run_agent_once(self) -> None:
        decision = self.agent.safe_decision(self.graph, self.trains, self.occupancy(), self.tick)
        if decision is None:
            return
        self._apply_agent_decision(decision)

    def _apply_agent_decision(self, decision: AgentDecision) -> None:
        train = self.trains.get(decision.train_id)
        if train is None:
            return

        if decision.decision == "reroute" and decision.new_route:
            self._assign_route(train, decision.new_route, source=decision.source, reason=decision.reason)
        elif decision.decision == "hold":
            train.stop()
            train.hold_at = train.next_node or train.current_node
        elif decision.decision == "stop":
            train.stop()

        payload = decision.to_dict()
        train.last_agent_action = payload
        self.last_agent_decision = payload
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type=decision.decision,
            severity="warning" if decision.decision != "hold" else "critical",
            message=f"{train.id} {decision.decision} decision from {decision.source}.",
            train_id=train.id,
            details=payload,
        )

    def _reroute_train(self, train: Train, source: str, forced: bool = False) -> None:
        start_node = train.next_node if train.on_edge else train.current_node
        if start_node is None:
            raise SimulationError(f"Cannot reroute {train.id} without a known current position.")
        if not forced and self.tick - train.last_reroute_tick < REROUTE_COOLDOWN_TICKS:
            return
        new_route = self.graph.dijkstra(start_node, train.destination, self.occupancy())
        if not new_route:
            self._handle_route_unavailable(train, start_node)
            return
        route_tail = self._route_tail(train, start_node)
        if new_route == route_tail:
            return
        self._assign_route(train, new_route, source=source, reason="dispatcher_requested_reroute")

    def _optimize_train_route(self, train: Train, reason: str) -> bool:
        start_node = train.next_node if train.on_edge else train.current_node
        if start_node is None:
            return False
        new_route = self.graph.dijkstra(start_node, train.destination, self.occupancy())
        if not new_route:
            return False
        old_route = self._route_tail(train, start_node)
        if new_route == old_route:
            return False
        old_minutes = self.graph.total_route_minutes(old_route, self.occupancy())
        new_minutes = self.graph.total_route_minutes(new_route, self.occupancy())
        if new_minutes + 1 >= old_minutes:
            return False
        self._assign_route(train, new_route, source="optimizer", reason=reason)
        return True

    def _assign_route(self, train: Train, new_route: list[str], source: str, reason: str) -> None:
        start_node = train.next_node if train.on_edge else train.current_node
        if start_node is None:
            raise SimulationError(f"Cannot assign route to {train.id} without a known current position.")
        valid, validation_reason = self.graph.validate_route(new_route, {start_node}, train.destination)
        if not valid:
            self.logs.add(
                tick=self.tick,
                sim_time=self.sim_time,
                type="invalid_route",
                severity="warning",
                message=f"Route assignment rejected for {train.id}.",
                train_id=train.id,
                details={"reason": validation_reason, "route": new_route},
            )
            raise SimulationError(validation_reason)

        old_route = self._route_tail(train, start_node)
        if old_route == new_route:
            return

        if train.on_edge:
            train.queue_route_after_edge(new_route)
            train.last_reroute_tick = self.tick
            message = f"{train.id} reroute queued until arrival at {start_node}."
            log_type = "reroute_queued"
        else:
            train.apply_route_from_node(new_route, self.tick)
            self._prepare_next_edge(train)
            message = f"{train.id} rerouted."
            log_type = "reroute"

        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type=log_type,
            severity="warning",
            message=message,
            train_id=train.id,
            details={
                "source": source,
                "reason": reason,
                "old_route": old_route,
                "new_route": new_route,
            },
        )

    def _handle_route_unavailable(self, train: Train, hold_at: str) -> None:
        train.status = "stopped"
        train.current_speed = 0
        train.hold_at = hold_at
        self.logs.add(
            tick=self.tick,
            sim_time=self.sim_time,
            type="route_unavailable",
            severity="critical",
            message=f"No available route for {train.id}; train is held at {hold_at}.",
            train_id=train.id,
            details={"hold_at": hold_at, "destination": train.destination},
        )

    def _route_tail(self, train: Train, start_node: str) -> list[str]:
        if start_node in train.route:
            return train.route[train.route.index(start_node) :]
        return [start_node, train.destination]

    def _route_intersects(self, route: list[str], edge_ids: set[str]) -> bool:
        return any(edge_id in edge_ids for edge_id in self.graph.route_edges(route))

    def _require_train(self, train_id: str) -> Train:
        train = self.trains.get(train_id)
        if train is None:
            raise SimulationError(f"Unknown train id: {train_id}", status_code=404)
        return train

    def _require_edge(self, edge_id: str) -> Edge:
        edge = self.graph.get_edge_by_id(edge_id)
        if edge is None:
            raise SimulationError(f"Unknown track id: {edge_id}", status_code=404)
        return edge

    def _scenario_trains(self, scenario: str) -> list[dict[str, Any]]:
        scenarios: dict[str, list[dict[str, Any]]] = {
            "single_express": [
                {
                    "id": "RF-900",
                    "name": "Control Express",
                    "type": "express",
                    "source": "NDLS",
                    "destination": "LKO",
                    "scheduled_departure_tick": 0,
                }
            ],
            "bareilly_closure": [
                {
                    "id": "RF-101",
                    "name": "Gomti Priority",
                    "type": "superfast",
                    "source": "NDLS",
                    "destination": "LKO",
                    "scheduled_departure_tick": 0,
                },
                {
                    "id": "RF-202",
                    "name": "Bareilly Passenger",
                    "type": "passenger",
                    "source": "NDLS",
                    "destination": "LKO",
                    "scheduled_departure_tick": 2,
                },
            ],
            "kanpur_pressure": [
                {
                    "id": "RF-301",
                    "name": "Kanpur Superfast",
                    "type": "superfast",
                    "source": "NDLS",
                    "destination": "LKO",
                    "scheduled_departure_tick": 0,
                    "route": ["NDLS", "DSA", "GZB", "KRJ", "ALJN", "HRS", "TDL", "FZD", "SKB", "ETW", "PHD", "CNB", "ON", "LKO"],
                },
                {
                    "id": "RF-302",
                    "name": "Kanpur Passenger",
                    "type": "passenger",
                    "source": "NDLS",
                    "destination": "LKO",
                    "scheduled_departure_tick": 1,
                    "route": ["NDLS", "DSA", "GZB", "KRJ", "ALJN", "HRS", "TDL", "FZD", "SKB", "ETW", "PHD", "CNB", "ON", "LKO"],
                },
                {
                    "id": "RF-303",
                    "name": "Kanpur Freight",
                    "type": "freight",
                    "source": "CNB",
                    "destination": "NDLS",
                    "scheduled_departure_tick": 2,
                },
            ],
            "mixed_peak": [
                {
                    "id": "RF-101",
                    "name": "Gomti Priority",
                    "type": "superfast",
                    "source": "NDLS",
                    "destination": "LKO",
                    "scheduled_departure_tick": 0,
                },
                {
                    "id": "RF-202",
                    "name": "Bareilly Passenger",
                    "type": "passenger",
                    "source": "NDLS",
                    "destination": "LKO",
                    "scheduled_departure_tick": 3,
                },
                {
                    "id": "RF-303",
                    "name": "Kanpur Freight",
                    "type": "freight",
                    "source": "CNB",
                    "destination": "NDLS",
                    "scheduled_departure_tick": 4,
                },
                {
                    "id": "RF-404",
                    "name": "Hardoi Local",
                    "type": "passenger",
                    "source": "LKO",
                    "destination": "MB",
                    "scheduled_departure_tick": 8,
                },
            ],
        }
        return scenarios.get(scenario, scenarios["mixed_peak"])

    def _scenario_incidents(self, scenario: str) -> list[dict[str, Any]]:
        if scenario == "bareilly_closure":
            return [
                {
                    "type": "track_closure",
                    "edge_id": "BE-PMR",
                    "severity": "critical",
                    "note": "Seeded closure near Bareilly.",
                }
            ]
        if scenario == "mixed_peak":
            return [
                {
                    "type": "speed_restriction",
                    "edge_id": "BE-PMR",
                    "severity": "warning",
                    "speed_limit": 35,
                    "note": "Seeded restriction near Bareilly.",
                }
            ]
        return []
