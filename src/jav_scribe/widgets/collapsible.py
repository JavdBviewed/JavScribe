from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QSizePolicy,
    QToolButton,
    QVBoxLayout,
    QWidget,
)


class CollapsibleBox(QWidget):
    """A simple animated collapsible group box."""

    toggled_state = Signal(bool)  # expanded

    def __init__(self, title: str, expanded: bool = False, parent=None) -> None:
        super().__init__(parent)
        # The box itself should shrink to fit its (possibly hidden) content.
        self.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Maximum)

        self.button = QToolButton()
        self.button.setText(title)
        self.button.setCheckable(True)
        self.button.setChecked(expanded)
        self.button.setStyleSheet(
            "QToolButton { border: none; font-weight: bold; padding: 4px; "
            "background: transparent; color: #a0a0a8; }"
        )
        self.button.setToolButtonStyle(Qt.ToolButtonTextBesideIcon)
        self.button.setArrowType(Qt.DownArrow if expanded else Qt.RightArrow)
        self.button.clicked.connect(self._on_toggle)

        self.content = QFrame()
        self.content.setFrameShape(QFrame.NoFrame)
        self.content.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Maximum)
        self.content_layout = QVBoxLayout(self.content)
        self.content_layout.setContentsMargins(12, 4, 8, 4)
        self.content.setVisible(expanded)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(2)
        header = QHBoxLayout()
        header.setContentsMargins(0, 0, 0, 0)
        header.addWidget(self.button)
        header.addStretch(1)
        outer.addLayout(header)
        outer.addWidget(self.content)

    def _on_toggle(self, checked: bool) -> None:
        self.button.setArrowType(Qt.DownArrow if checked else Qt.RightArrow)
        self.content.setVisible(checked)
        # Force the parent chain to recompute layout / repaint so we don't
        # leave a stale paint region (the "ghost trail" seen on maximize).
        self.updateGeometry()
        node = self.parentWidget()
        while node is not None:
            node.updateGeometry()
            node = node.parentWidget()
        top = self.window()
        if top is not None:
            top.update()
        self.toggled_state.emit(checked)

    def add_content_widget(self, w: QWidget) -> None:
        self.content_layout.addWidget(w)

    def set_content_layout(self, layout) -> None:
        # Replace the default vertical layout with the given one
        old = self.content.layout()
        if old is not None:
            QWidget().setLayout(old)
        self.content.setLayout(layout)
        self.content_layout = layout
