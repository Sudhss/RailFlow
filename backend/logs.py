from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class EventLog:
    id: str
    tick: int
    sim_time: str
    type: str
    severity: str
    message: str
    train_id: str | None = None
    edge_id: str | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "tick": self.tick,
            "sim_time": self.sim_time,
            "type": self.type,
            "severity": self.severity,
            "message": self.message,
            "train_id": self.train_id,
            "edge_id": self.edge_id,
            "details": self.details,
        }


class LogBook:
    def __init__(self, max_items: int = 500):
        self.max_items = max_items
        self._counter = 0
        self._items: list[EventLog] = []

    def add(
        self,
        tick: int,
        sim_time: str,
        type: str,
        severity: str,
        message: str,
        train_id: str | None = None,
        edge_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> EventLog:
        self._counter += 1
        event = EventLog(
            id=f"evt_{self._counter}",
            tick=tick,
            sim_time=sim_time,
            type=type,
            severity=severity,
            message=message,
            train_id=train_id,
            edge_id=edge_id,
            details=details or {},
        )
        self._items.append(event)
        if len(self._items) > self.max_items:
            self._items = self._items[-self.max_items :]
        return event

    def clear(self) -> None:
        self._items.clear()
        self._counter = 0

    def all(self) -> list[dict[str, Any]]:
        return [item.to_dict() for item in self._items]

    def latest(self, limit: int = 20) -> list[dict[str, Any]]:
        return [item.to_dict() for item in self._items[-limit:]]
