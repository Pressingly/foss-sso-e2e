import pytest
from test_writer_agent.config import load


REQUIRED = {
    "PLANE_API_TOKEN": "tok",
    "PLANE_BASE_URL": "https://plane.example.com",
    "PLANE_WORKSPACE_SLUG": "myslug",
    "PLANE_PROJECT_ID": "proj-uuid",
    "FOSS_USER": "testuser",
    "FOSS_PASS": "testpass",
}


def test_load_succeeds_with_all_vars(monkeypatch):
    for k, v in REQUIRED.items():
        monkeypatch.setenv(k, v)
    cfg = load()
    assert cfg.plane_api_token == "tok"
    assert cfg.plane_base_url == "https://plane.example.com"
    assert cfg.foss_user == "testuser"
    assert cfg.foss_pass == "testpass"
    assert cfg.log_level == "INFO"


def test_load_raises_on_missing_vars(monkeypatch):
    for k in REQUIRED:
        monkeypatch.delenv(k, raising=False)
    with pytest.raises(EnvironmentError) as exc:
        load()
    msg = str(exc.value)
    for k in REQUIRED:
        assert k in msg


def test_load_raises_on_partial_missing(monkeypatch):
    for k, v in REQUIRED.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("PLANE_API_TOKEN")
    with pytest.raises(EnvironmentError) as exc:
        load()
    assert "PLANE_API_TOKEN" in str(exc.value)


def test_log_level_override(monkeypatch):
    for k, v in REQUIRED.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    cfg = load()
    assert cfg.log_level == "DEBUG"
