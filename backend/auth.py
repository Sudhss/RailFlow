from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROLE_LEVELS = {
    "viewer": 1,
    "dispatcher": 2,
    "admin": 3,
}


@dataclass
class User:
    username: str
    role: str

    def to_dict(self) -> dict[str, Any]:
        return {"username": self.username, "role": self.role}


class AuthService:
    def __init__(self, users_path: str | Path):
        self.users_path = Path(users_path)
        self.users = self._load_users()
        self.sessions: dict[str, User] = {}

    def _load_users(self) -> dict[str, dict[str, str]]:
        data = json.loads(self.users_path.read_text(encoding="utf-8"))
        return {item["username"]: item for item in data}

    def login(self, username: str, password: str) -> tuple[str, User] | None:
        record = self.users.get(username)
        if record is None or record["password"] != password:
            return None
        user = User(username=username, role=record["role"])
        token = secrets.token_urlsafe(32)
        self.sessions[token] = user
        return token, user

    def logout(self, token: str) -> None:
        self.sessions.pop(token, None)

    def user_for_token(self, token: str | None) -> User | None:
        if not token:
            return None
        return self.sessions.get(token)

    @staticmethod
    def can(user: User, required_role: str) -> bool:
        return ROLE_LEVELS[user.role] >= ROLE_LEVELS[required_role]
