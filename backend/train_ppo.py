from __future__ import annotations

from pathlib import Path

from stable_baselines3 import PPO

from .rl_env import RailFlowEnv


BASE_DIR = Path(__file__).resolve().parent
GRAPH_PATH = BASE_DIR / "data" / "railway_graph.json"
MODEL_PATH = BASE_DIR / "models" / "railflow_ppo.zip"


def main() -> None:
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    env = RailFlowEnv(GRAPH_PATH)
    model = PPO("MlpPolicy", env, verbose=1)
    model.learn(total_timesteps=10000)
    model.save(str(MODEL_PATH))
    print(f"Saved PPO model to {MODEL_PATH}")


if __name__ == "__main__":
    main()
