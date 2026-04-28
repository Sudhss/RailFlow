from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

try:
    import gymnasium as gym
    from gymnasium import spaces
except Exception as exc:
    gym = None
    spaces = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None

from .simulation import RailFlowSimulation


if gym is not None:

    class RailFlowEnv(gym.Env):
        metadata = {"render_modes": []}

        def __init__(self, graph_path: str | Path, model_path: str | Path | None = None):
            super().__init__()
            self.simulation = RailFlowSimulation(graph_path, model_path or Path("__missing_model__.zip"))
            self.max_steps = 240
            self.action_space = spaces.Discrete(4)
            self.observation_space = spaces.Box(low=0.0, high=1.0, shape=(16,), dtype=np.float32)

        def reset(self, seed: int | None = None, options: dict[str, Any] | None = None):
            super().reset(seed=seed)
            self.simulation.seed_scenario()
            self.simulation.set_paused(False)
            return self._observation(), {}

        def step(self, action: int):
            if action == 1:
                self._reroute_most_delayed()
            elif action == 2:
                self._stop_lowest_priority()
            elif action == 3:
                self._resume_highest_priority_stopped()

            self.simulation.advance_tick()
            reward = self._reward()
            terminated = self.simulation.tick >= self.max_steps
            truncated = False
            return self._observation(), reward, terminated, truncated, {}

        def _observation(self):
            snapshot = self.simulation.snapshot()
            trains = snapshot["trains"]
            edges = snapshot["graph"]["edges"]
            delays = [min(1.0, train["delay"] / 60.0) for train in trains[:5]]
            congestion = [min(1.0, edge["load_ratio"]) for edge in edges[:8]]
            stopped_ratio = 0.0
            if trains:
                stopped_ratio = sum(1 for train in trains if train["status"] == "stopped") / len(trains)
            values = delays + congestion + [stopped_ratio, min(1.0, self.simulation.tick / self.max_steps)]
            values = values[:16] + [0.0] * max(0, 16 - len(values))
            return np.array(values, dtype=np.float32)

        def _reward(self):
            snapshot = self.simulation.snapshot()
            total_delay = sum(train["delay"] for train in snapshot["trains"])
            congestion_penalty = sum(max(0.0, edge["load_ratio"] - 1.0) * 10 for edge in snapshot["graph"]["edges"])
            stopped_penalty = sum(5 for train in snapshot["trains"] if train["status"] == "stopped")
            return float(-(total_delay + congestion_penalty + stopped_penalty))

        def _reroute_most_delayed(self):
            trains = list(self.simulation.trains.values())
            if trains:
                train = max(trains, key=lambda item: item.delay)
                try:
                    self.simulation.reroute_train(train.id)
                except Exception:
                    pass

        def _stop_lowest_priority(self):
            moving = [train for train in self.simulation.trains.values() if train.status == "moving"]
            if moving:
                train = min(moving, key=lambda item: (item.priority, item.delay))
                self.simulation.stop_train(train.id, reason="rl_training_action")

        def _resume_highest_priority_stopped(self):
            stopped = [train for train in self.simulation.trains.values() if train.status == "stopped"]
            if stopped:
                train = max(stopped, key=lambda item: (item.priority, item.delay))
                try:
                    self.simulation.resume_train(train.id)
                except Exception:
                    pass

else:

    class RailFlowEnv:
        def __init__(self, *args: Any, **kwargs: Any):
            raise RuntimeError(f"gymnasium is required for RailFlowEnv: {IMPORT_ERROR}")
