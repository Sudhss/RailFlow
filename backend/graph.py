from __future__ import annotations

import heapq
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


@dataclass
class Station:
    id: str
    name: str
    lat: float
    lng: float
    x: float
    y: float
    type: str
    dwell_base: int


@dataclass
class Edge:
    id: str
    from_node: str
    to_node: str
    distance_km: float
    avg_speed: float
    capacity: int
    bidirectional: bool = True
    blocked: bool = False
    speed_limit: float | None = None
    temporary: bool = False

    def connects(self, a: str, b: str) -> bool:
        if self.from_node == a and self.to_node == b:
            return True
        return self.bidirectional and self.from_node == b and self.to_node == a

    @property
    def effective_speed_limit(self) -> float:
        if self.speed_limit is None:
            return self.avg_speed
        return max(1.0, min(self.avg_speed, self.speed_limit))


class RailwayGraph:
    def __init__(self, data_path: str | Path):
        self.data_path = Path(data_path)
        self.name = ""
        self.sim_start = "06:00"
        self.stations: dict[str, Station] = {}
        self.edges: dict[str, Edge] = {}
        self.adjacency: dict[str, dict[str, str]] = {}
        self.reset()

    def reset(self) -> None:
        data = json.loads(self.data_path.read_text(encoding="utf-8"))
        self.name = data.get("name", "Railway Graph")
        self.sim_start = data.get("sim_start", "06:00")
        self.stations = {
            item["id"]: Station(
                id=item["id"],
                name=item["name"],
                lat=float(item["lat"]),
                lng=float(item["lng"]),
                x=float(item["x"]),
                y=float(item["y"]),
                type=item["type"],
                dwell_base=int(item["dwell_base"]),
            )
            for item in data["stations"]
        }
        self.edges = {}
        for item in data["edges"]:
            edge = self._edge_from_payload(item, temporary=False)
            self.edges[edge.id] = edge
        self._rebuild_adjacency()

    def _edge_from_payload(self, payload: dict[str, Any], temporary: bool) -> Edge:
        from_node = payload.get("from") or payload.get("from_node")
        to_node = payload.get("to") or payload.get("to_node")
        edge_id = payload.get("id") or self.edge_id_for(from_node, to_node)
        return Edge(
            id=edge_id,
            from_node=from_node,
            to_node=to_node,
            distance_km=float(payload["distance_km"]),
            avg_speed=float(payload["avg_speed"]),
            capacity=max(1, int(payload["capacity"])),
            bidirectional=bool(payload.get("bidirectional", True)),
            blocked=bool(payload.get("blocked", False)),
            speed_limit=payload.get("speed_limit"),
            temporary=temporary,
        )

    def _rebuild_adjacency(self) -> None:
        self.adjacency = {station_id: {} for station_id in self.stations}
        for edge in self.edges.values():
            self.adjacency.setdefault(edge.from_node, {})[edge.to_node] = edge.id
            if edge.bidirectional:
                self.adjacency.setdefault(edge.to_node, {})[edge.from_node] = edge.id

    @staticmethod
    def edge_id_for(from_node: str, to_node: str) -> str:
        return f"{from_node}-{to_node}"

    def get_edge(self, from_node: str, to_node: str) -> Edge | None:
        edge_id = self.adjacency.get(from_node, {}).get(to_node)
        if edge_id is None:
            return None
        return self.edges.get(edge_id)

    def get_edge_by_id(self, edge_id: str) -> Edge | None:
        return self.edges.get(edge_id)

    def add_or_update_edge(self, payload: dict[str, Any]) -> tuple[Edge, bool]:
        from_node = payload.get("from") or payload.get("from_node")
        to_node = payload.get("to") or payload.get("to_node")
        if from_node not in self.stations or to_node not in self.stations:
            raise ValueError("Track endpoints must be valid station ids.")

        existing = self.get_edge(from_node, to_node)
        if existing:
            existing.distance_km = float(payload.get("distance_km", existing.distance_km))
            existing.avg_speed = float(payload.get("avg_speed", existing.avg_speed))
            existing.capacity = max(1, int(payload.get("capacity", existing.capacity)))
            existing.bidirectional = bool(payload.get("bidirectional", existing.bidirectional))
            existing.blocked = bool(payload.get("blocked", existing.blocked))
            existing.speed_limit = payload.get("speed_limit", existing.speed_limit)
            self._rebuild_adjacency()
            return existing, False

        edge = self._edge_from_payload(payload, temporary=True)
        self.edges[edge.id] = edge
        self._rebuild_adjacency()
        return edge, True

    def delete_edge(self, edge_id: str) -> bool:
        if edge_id not in self.edges:
            return False
        del self.edges[edge_id]
        self._rebuild_adjacency()
        return True

    def set_blocked(self, edge_id: str, blocked: bool) -> Edge:
        edge = self._require_edge(edge_id)
        edge.blocked = blocked
        return edge

    def set_speed_limit(self, edge_id: str, speed_limit: float | None) -> Edge:
        edge = self._require_edge(edge_id)
        if speed_limit is None:
            edge.speed_limit = None
        else:
            edge.speed_limit = max(1.0, float(speed_limit))
        return edge

    def _require_edge(self, edge_id: str) -> Edge:
        edge = self.edges.get(edge_id)
        if edge is None:
            raise ValueError(f"Unknown track id: {edge_id}")
        return edge

    def dynamic_weight(self, edge: Edge, trains_on_edge: int = 0) -> float:
        if edge.blocked:
            return math.inf

        base_minutes = edge.distance_km / edge.effective_speed_limit * 60.0
        load_ratio = trains_on_edge / max(1, edge.capacity)
        if load_ratio <= 0.7:
            congestion_multiplier = 1.0
        elif load_ratio <= 1.0:
            congestion_multiplier = 1.0 + (load_ratio - 0.7) * 1.4
        else:
            congestion_multiplier = load_ratio * 2.0
        return base_minutes * congestion_multiplier

    def dijkstra(
        self,
        start: str,
        destination: str,
        occupancy: dict[str, int] | None = None,
    ) -> list[str] | None:
        if start not in self.stations or destination not in self.stations:
            return None
        occupancy = occupancy or {}
        distances: dict[str, float] = {station_id: math.inf for station_id in self.stations}
        previous: dict[str, str | None] = {station_id: None for station_id in self.stations}
        distances[start] = 0.0
        queue: list[tuple[float, str]] = [(0.0, start)]

        while queue:
            distance, node = heapq.heappop(queue)
            if distance > distances[node]:
                continue
            if node == destination:
                break
            for neighbor, edge_id in self.adjacency.get(node, {}).items():
                edge = self.edges[edge_id]
                weight = self.dynamic_weight(edge, occupancy.get(edge_id, 0))
                if math.isinf(weight):
                    continue
                candidate = distance + weight
                if candidate < distances[neighbor]:
                    distances[neighbor] = candidate
                    previous[neighbor] = node
                    heapq.heappush(queue, (candidate, neighbor))

        if math.isinf(distances[destination]):
            return None

        path: list[str] = []
        cursor: str | None = destination
        while cursor is not None:
            path.append(cursor)
            cursor = previous[cursor]
        path.reverse()
        return path

    def validate_route(
        self,
        route: list[str],
        allowed_starts: set[str],
        destination: str,
    ) -> tuple[bool, str]:
        if not route:
            return False, "Route cannot be empty."
        if route[0] not in allowed_starts:
            return False, "Route must start from the train's current or next station."
        if route[-1] != destination:
            return False, "Route must end at the train destination."
        for station_id in route:
            if station_id not in self.stations:
                return False, f"Unknown station id: {station_id}"
        for from_node, to_node in zip(route, route[1:]):
            edge = self.get_edge(from_node, to_node)
            if edge is None:
                return False, f"No track exists between {from_node} and {to_node}."
            if edge.blocked:
                return False, f"Track {edge.id} is blocked."
        return True, "Route is valid."

    def route_edges(self, route: list[str]) -> list[str]:
        edge_ids: list[str] = []
        for from_node, to_node in zip(route, route[1:]):
            edge = self.get_edge(from_node, to_node)
            if edge:
                edge_ids.append(edge.id)
        return edge_ids

    def total_route_minutes(self, route: list[str], occupancy: dict[str, int] | None = None) -> float:
        occupancy = occupancy or {}
        total = 0.0
        for edge_id in self.route_edges(route):
            edge = self.edges[edge_id]
            total += self.dynamic_weight(edge, occupancy.get(edge_id, 0))
        return total

    def snapshot(self, occupancy: dict[str, int] | None = None) -> dict[str, Any]:
        occupancy = occupancy or {}
        return {
            "name": self.name,
            "stations": [asdict(station) for station in self.stations.values()],
            "edges": [self.edge_snapshot(edge, occupancy.get(edge.id, 0)) for edge in self.edges.values()],
        }

    def edge_snapshot(self, edge: Edge, trains_on_edge: int = 0) -> dict[str, Any]:
        load_ratio = trains_on_edge / max(1, edge.capacity)
        if edge.blocked:
            congestion = "closed"
        elif load_ratio < 0.7:
            congestion = "normal"
        elif load_ratio <= 1.0:
            congestion = "busy"
        else:
            congestion = "congested"

        payload = asdict(edge)
        payload["from"] = payload.pop("from_node")
        payload["to"] = payload.pop("to_node")
        payload["trains_on_edge"] = trains_on_edge
        payload["load_ratio"] = round(load_ratio, 3)
        payload["congestion"] = congestion
        dynamic_weight = self.dynamic_weight(edge, trains_on_edge)
        payload["dynamic_weight"] = None if math.isinf(dynamic_weight) else round(dynamic_weight, 3)
        return payload
