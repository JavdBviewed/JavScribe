from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QComboBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QRadioButton,
    QVBoxLayout,
    QWidget,
)

from ..constants import DEVICES
from ..core.presets import PRESETS, ModePreset


def scan_models(infer_dir: Path) -> list[tuple[str, str]]:
    models_dir = infer_dir / "models"
    out: list[tuple[str, str]] = []
    if not models_dir.exists():
        return out

    if (models_dir / "config.json").exists() or (models_dir / "model.bin").exists():
        out.append(("默认 (models)", "models"))

    for sub in sorted(models_dir.iterdir()):
        if sub.is_dir() and (sub / "config.json").exists():
            out.append((sub.name, f"models/{sub.name}"))

    if not out:
        out.append(("默认 (models)", "models"))
    return out


class ModeBar(QWidget):
    preset_changed = Signal(str)
    model_changed = Signal(str)
    device_changed = Signal(str)
    refresh_models = Signal()

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._radios: dict[str, QRadioButton] = {}
        self._build_ui()
        self._radios["gpu"].setChecked(True)

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)

        header = QLabel("性能预设")
        header.setStyleSheet("font-weight: bold; color: #a0a0a8;")
        layout.addWidget(header)

        preset_row = QHBoxLayout()
        preset_row.setSpacing(8)
        for p in PRESETS:
            rb = QRadioButton(p.label)
            rb.setToolTip(p.description)
            rb.toggled.connect(lambda checked, k=p.key: self._on_preset(k, checked))
            preset_row.addWidget(rb)
            self._radios[p.key] = rb
        preset_row.addStretch(1)
        layout.addLayout(preset_row)

        config_row = QHBoxLayout()
        config_row.addWidget(QLabel("模型:"))
        self.model_combo = QComboBox()
        self.model_combo.setMinimumWidth(180)
        self.model_combo.currentIndexChanged.connect(self._on_model)
        config_row.addWidget(self.model_combo, 1)

        self.btn_refresh = QPushButton("刷新")
        self.btn_refresh.setMinimumWidth(60)
        self.btn_refresh.clicked.connect(self.refresh_models)
        config_row.addWidget(self.btn_refresh)

        config_row.addSpacing(8)
        config_row.addWidget(QLabel("设备:"))
        self.device_combo = QComboBox()
        self.device_combo.addItems(DEVICES)
        self.device_combo.currentTextChanged.connect(self.device_changed)
        config_row.addWidget(self.device_combo)

        layout.addLayout(config_row)

    def _on_preset(self, key: str, checked: bool) -> None:
        if not checked:
            return
        preset = next((p for p in PRESETS if p.key == key), None)
        if preset and preset.key != "custom":
            i = self.device_combo.findText(preset.device)
            if i >= 0:
                self.device_combo.blockSignals(True)
                self.device_combo.setCurrentIndex(i)
                self.device_combo.blockSignals(False)
        self.preset_changed.emit(key)

    def _on_model(self, idx: int) -> None:
        path = self.model_combo.itemData(idx)
        if path is not None:
            self.model_changed.emit(path)

    def selected_preset(self) -> ModePreset:
        for k, rb in self._radios.items():
            if rb.isChecked():
                return next(p for p in PRESETS if p.key == k)
        return PRESETS[0]

    def selected_device(self) -> str:
        return self.device_combo.currentText()

    def selected_model_path(self) -> str:
        return self.model_combo.currentData() or "models"

    def set_models(self, items: list[tuple[str, str]]) -> None:
        self.model_combo.blockSignals(True)
        current = self.model_combo.currentData()
        self.model_combo.clear()
        for label, path in items:
            self.model_combo.addItem(label, path)
        if current:
            i = self.model_combo.findData(current)
            if i >= 0:
                self.model_combo.setCurrentIndex(i)
        self.model_combo.blockSignals(False)

    def set_preset(self, key: str) -> None:
        if key in self._radios:
            self._radios[key].setChecked(True)

    def set_device(self, device: str) -> None:
        i = self.device_combo.findText(device)
        if i >= 0:
            self.device_combo.setCurrentIndex(i)

    def set_model_path(self, path: str) -> None:
        i = self.model_combo.findData(path)
        if i >= 0:
            self.model_combo.setCurrentIndex(i)

    def to_dict(self) -> dict:
        return {
            "preset": self.selected_preset().key,
            "device": self.selected_device(),
            "model_path": self.selected_model_path(),
        }

    def from_dict(self, data: dict) -> None:
        if not data:
            return
        if "preset" in data:
            self.set_preset(data["preset"])
        if "device" in data:
            self.set_device(data["device"])
        if "model_path" in data:
            self.set_model_path(data["model_path"])
