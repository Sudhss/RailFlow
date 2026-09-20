from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


TRAIN_TYPE_PROFILES: dict[str, dict[str, Any]] = {
    "superfast": {
        "priority": 5,
        "max_speed": 120,
        "minor_stop": False,
        "dwell_multiplier": 0.8,
    },
    "express": {
        "priority": 4,
        "max_speed": 105,
        "minor_stop": False,
        "dwell_multiplier": 1.0,
    },
    "passenger": {
        "priority": 3,
        "max_speed": 80,
        "minor_stop": True,
        "dwell_multiplier": 1.3,
    },
    "freight": {
        "priority": 2,
        "max_speed": 65,
        "minor_stop": False,
        "dwell_multiplier": 1.8,
    },
    "maintenance": {
        "priority": 1,
        "max_speed": 40,
        "minor_stop": True,
        "dwell_multiplier": 1.5,
    },
}


# Holds raised by the system (agent, blocked track, emergency halt) are released
# automatically once the cause clears. A hold with reason None is a dispatcher
# decision and is only ever released by a dispatcher.
SYSTEM_HOLD_REASONS = {
    "track_blocked",
    "route_unavailable",
    "agent_hold",
    "agent_capacity_relief",
    "emergency_halt",
    "corridor_halt",
}


@dataclass
class Train:
    id: str
    name: str
    type: str
    priority: int
    source: str
    destination: str
    route: list[str]
    scheduled_departure_tick: int
    max_speed: float
    status: str = "scheduled"
    current_node: str | None = None
    next_node: str | None = None
    edge_id: str | None = None
    edge_progress: float = 0.0
    current_speed: float = 0.0
    delay: int = 0
    route_index: int = 0
    dwell_remaining: int = 0
    hold_at: str | None = None
    hold_reason: str | None = None
    pending_reroute: bool = False
    requested_route: list[str] | None = None
    last_reroute_tick: int = -9999
    completed_tick: int | None = None
    history: list[str] = field(default_factory=list)
    last_agent_action: dict[str, Any] | None = field(default=None)

    @property
    def departed(self) -> bool:
        return self.status not in {"scheduled"}

    @property
    def system_held(self) -> bool:
        """True when the train is stopped by the system rather than by a dispatcher."""
        return self.status == "stopped" and self.hold_reason in SYSTEM_HOLD_REASONS

    @property
    def display_route(self) -> list[str]:
        """Full journey: stations already visited, then the remaining plan.

        ``route`` only ever holds the *remaining* plan from the current node, so
        after a reroute the origin would otherwise disappear from the UI.
        """
        if not self.history:
            return list(self.route)
        return self.history + self.route[self.route_index + 1 :]

    @property
    def complete(self) -> bool:
        return self.status == "arrived"

    @property
    def on_edge(self) -> bool:
        return self.edge_id is not None and self.next_node is not None

    def allowed_route_starts(self) -> set[str]:
        starts = set()
        if self.current_node:
            starts.add(self.current_node)
        if self.next_node:
            starts.add(self.next_node)
        return starts

    def __post_init__(self) -> None:
        if not self.history:
            self.history = [self.route[0]] if self.route else [self.source]

    def record_arrival(self, station_id: str) -> None:
        """Append a station the train has physically reached."""
        if not self.history or self.history[-1] != station_id:
            self.history.append(station_id)

    def start(self) -> None:
        self.current_node = self.route[0]
        self.route_index = 0
        self.record_arrival(self.route[0])
        if len(self.route) == 1:
            self.status = "arrived"
            self.current_speed = 0
            return
        self.status = "moving"
        self.next_node = self.route[1]
        self.edge_progress = 0.0

    def stop(self, reason: str | None = None) -> None:
        if self.status == "arrived":
            return
        if self.status == "stopped" and self.hold_reason is None and reason is not None:
            # Already held by a dispatcher. A system hold must not take the hold
            # over, or releasing the system cause would restart a train that a
            # person deliberately stopped.
            return
        self.status = "stopped"
        self.current_speed = 0.0
        self.hold_reason = reason

    def resume(self) -> None:
        if self.status == "stopped":
            self.hold_reason = None
            self.hold_at = None
            if self.dwell_remaining > 0:
                self.status = "dwelling"
            elif self.next_node:
                self.status = "moving"
            else:
                self.status = "scheduled"

    def apply_route_from_node(self, new_route: list[str], tick: int) -> None:
        self.route = new_route
        self.route_index = 0
        self.current_node = new_route[0]
        self.next_node = new_route[1] if len(new_route) > 1 else None
        self.edge_id = None
        self.edge_progress = 0.0
        self.pending_reroute = False
        self.requested_route = None
        self.last_reroute_tick = tick
        self.hold_at = None
        self.hold_reason = None
        self.record_arrival(new_route[0])
        if self.next_node is None:
            self.status = "arrived"
        elif self.status not in {"scheduled", "stopped"}:
            # A new plan must not start a train that has not departed yet, and
            # must not restart one a dispatcher deliberately stopped.
            self.status = "moving"

    def queue_route_after_edge(self, new_route: list[str]) -> None:
        self.pending_reroute = True
        self.requested_route = new_route

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["on_edge"] = self.on_edge
        payload["departed"] = self.departed
        payload["complete"] = self.complete
        payload["system_held"] = self.system_held
        payload["display_route"] = self.display_route
        return payload


def profile_for_train_type(train_type: str) -> dict[str, Any]:
    if train_type not in TRAIN_TYPE_PROFILES:
        raise ValueError(
            f"Unknown train type: {train_type}. Valid types: {', '.join(TRAIN_TYPE_PROFILES)}."
        )
    return TRAIN_TYPE_PROFILES[train_type]
