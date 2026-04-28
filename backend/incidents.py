from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class Incident:
    id: str
    type: str
    edge_id: str
    severity: str
    active: bool
    created_tick: int
    speed_limit: float | None = None
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class IncidentRegistry:
    def __init__(self):
        self._counter = 0
        self._items: dict[str, Incident] = {}

    def add(
        self,
        type: str,
        edge_id: str,
        severity: str,
        created_tick: int,
        speed_limit: float | None = None,
        note: str = "",
    ) -> Incident:
        self._counter += 1
        incident = Incident(
            id=f"inc_{self._counter}",
            type=type,
            edge_id=edge_id,
            severity=severity,
            active=True,
            created_tick=created_tick,
            speed_limit=speed_limit,
            note=note,
        )
        self._items[incident.id] = incident
        return incident

    def resolve(self, incident_id: str) -> Incident | None:
        incident = self._items.get(incident_id)
        if incident:
            incident.active = False
        return incident

    def clear(self) -> None:
        self._counter = 0
        self._items.clear()

    def active_for_edge(self, edge_id: str) -> list[Incident]:
        return [item for item in self._items.values() if item.edge_id == edge_id and item.active]

    def all(self) -> list[dict[str, Any]]:
        return [item.to_dict() for item in self._items.values()]

    def active(self) -> list[dict[str, Any]]:
        return [item.to_dict() for item in self._items.values() if item.active]
