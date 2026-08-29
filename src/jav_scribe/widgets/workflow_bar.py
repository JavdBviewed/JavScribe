from __future__ import annotations

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QHBoxLayout, QRadioButton, QWidget

from ..constants import WORKFLOW_MODES, WORKFLOW_MODE_LABELS


class WorkflowBar(QWidget):
    mode_changed = Signal(str)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._radios: dict[str, QRadioButton] = {}
        self._build_ui()
        self._radios["restore_and_subtitle"].setChecked(True)

    def _build_ui(self) -> None:
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(4)

        for mode_key in WORKFLOW_MODES:
            rb = QRadioButton(WORKFLOW_MODE_LABELS[mode_key])
            rb.toggled.connect(lambda checked, k=mode_key: self._on_mode(k, checked))
            layout.addWidget(rb)
            self._radios[mode_key] = rb

        layout.addStretch(1)

    def _on_mode(self, key: str, checked: bool) -> None:
        if checked:
            self.mode_changed.emit(key)

    def selected_mode(self) -> str:
        for k, rb in self._radios.items():
            if rb.isChecked():
                return k
        return "restore_and_subtitle"

    def set_mode(self, mode: str) -> None:
        if mode in self._radios:
            self._radios[mode].setChecked(True)

    def to_dict(self) -> dict:
        return {"mode": self.selected_mode()}

    def from_dict(self, data: dict) -> None:
        if not data:
            return
        if "mode" in data:
            self.set_mode(data["mode"])
