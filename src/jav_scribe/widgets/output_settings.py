from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QRadioButton,
    QVBoxLayout,
    QWidget,
)

from ..constants import DEFAULT_LANG_TAG, DEFAULT_SUB_FORMATS, SUB_FORMATS, SUB_LANG_TAGS


class OutputSettings(QWidget):
    changed = Signal()

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._build_ui()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setSpacing(6)

        # Subtitle formats ---------------------------------------------
        fmt_row = QHBoxLayout()
        fmt_row.addWidget(QLabel("字幕格式:"))
        self.format_checks: dict[str, QCheckBox] = {}
        for fmt in SUB_FORMATS:
            cb = QCheckBox(fmt)
            cb.setChecked(fmt in DEFAULT_SUB_FORMATS)
            cb.stateChanged.connect(self.changed)
            fmt_row.addWidget(cb)
            self.format_checks[fmt] = cb
        fmt_row.addStretch(1)
        layout.addLayout(fmt_row)

        # Subtitle output destination -----------------------------------
        dest_label = QLabel("字幕输出位置:")
        layout.addWidget(dest_label)
        self.rb_same = QRadioButton("与源文件同目录")
        self.rb_custom = QRadioButton("自定义目录")
        self.rb_same.setChecked(True)
        self.rb_same.toggled.connect(self._on_dest_toggled)
        self.rb_custom.toggled.connect(self._on_dest_toggled)
        self.rb_same.toggled.connect(self.changed)

        layout.addWidget(self.rb_same)

        custom_row = QHBoxLayout()
        custom_row.setContentsMargins(20, 0, 0, 0)
        custom_row.addWidget(self.rb_custom)
        self.output_dir_edit = QLineEdit()
        self.output_dir_edit.setPlaceholderText("选择一个目录或填写路径")
        self.output_dir_edit.setEnabled(False)
        self.output_dir_edit.textChanged.connect(self.changed)
        self.btn_browse = QPushButton("浏览…")
        self.btn_browse.setEnabled(False)
        self.btn_browse.clicked.connect(self._browse_dir)
        custom_row.addWidget(self.output_dir_edit, 1)
        custom_row.addWidget(self.btn_browse)
        layout.addLayout(custom_row)

        # Overwrite / skip ---------------------------------------------
        self.cb_overwrite = QCheckBox("覆盖已存在的字幕")
        self.cb_overwrite.stateChanged.connect(self.changed)
        layout.addWidget(self.cb_overwrite)
        self.cb_skip_exists = QCheckBox("目标字幕已存在时跳过（BT/PT 重下不重复生成）")
        self.cb_skip_exists.setChecked(True)
        self.cb_skip_exists.stateChanged.connect(self.changed)
        layout.addWidget(self.cb_skip_exists)

        # Language tag ---------------------------------------------------
        lang_row = QHBoxLayout()
        lang_row.addWidget(QLabel("语言标签:"))
        self.lang_combo = QComboBox()
        self.lang_combo.addItems(SUB_LANG_TAGS)
        i = self.lang_combo.findText(DEFAULT_LANG_TAG)
        if i >= 0:
            self.lang_combo.setCurrentIndex(i)
        self.lang_combo.currentTextChanged.connect(self.changed)
        lang_row.addWidget(self.lang_combo)
        lang_tip = QLabel("最终文件: <影片名>.<标签>.srt（none=不加标签）")
        lang_tip.setStyleSheet("color: #8a8a93; font-size: 8pt;")
        lang_row.addWidget(lang_tip, 1)
        layout.addLayout(lang_row)

        # === Restore output settings ===
        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setFrameShadow(QFrame.Plain)
        sep.setStyleSheet("color: #2d2d34; margin: 6px 0;")
        layout.addWidget(sep)

        restore_header = QLabel("修复输出")
        restore_header.setStyleSheet("font-weight: bold; color: #a0a0a8; margin-top: 4px;")
        layout.addWidget(restore_header)

        # Restore output directory
        restore_dest_label = QLabel("修复输出位置:")
        layout.addWidget(restore_dest_label)
        self.rb_restore_same = QRadioButton("与源文件同目录")
        self.rb_restore_custom = QRadioButton("自定义目录")
        self.rb_restore_same.setChecked(True)
        self.rb_restore_same.toggled.connect(self._on_restore_dest_toggled)
        self.rb_restore_custom.toggled.connect(self._on_restore_dest_toggled)
        self.rb_restore_same.toggled.connect(self.changed)
        layout.addWidget(self.rb_restore_same)

        restore_custom_row = QHBoxLayout()
        restore_custom_row.setContentsMargins(20, 0, 0, 0)
        restore_custom_row.addWidget(self.rb_restore_custom)
        self.restore_output_dir_edit = QLineEdit()
        self.restore_output_dir_edit.setPlaceholderText("修复后视频的输出目录")
        self.restore_output_dir_edit.setEnabled(False)
        self.restore_output_dir_edit.textChanged.connect(self.changed)
        self.btn_restore_browse = QPushButton("浏览…")
        self.btn_restore_browse.setEnabled(False)
        self.btn_restore_browse.clicked.connect(self._browse_restore_dir)
        restore_custom_row.addWidget(self.restore_output_dir_edit, 1)
        restore_custom_row.addWidget(self.btn_restore_browse)
        layout.addLayout(restore_custom_row)

        # Restore output pattern
        pattern_row = QHBoxLayout()
        pattern_row.addWidget(QLabel("输出文件名:"))
        self.restore_pattern_edit = QLineEdit("{original}_restored.mp4")
        self.restore_pattern_edit.textChanged.connect(self.changed)
        pattern_row.addWidget(self.restore_pattern_edit, 1)
        layout.addLayout(pattern_row)

        # Tips section
        layout.addSpacing(16)
        tips = QLabel(
            "提示：输出文件名支持 {original} 占位符，"
            "系统会自动将其替换为原始视频文件名。\n"
            "自定义路径未指定时，默认输出至源文件同级目录。"
        )
        tips.setWordWrap(True)
        tips.setStyleSheet("color: #8a8a93; font-size: 8pt; padding: 8px;")
        layout.addWidget(tips)

    def _on_dest_toggled(self) -> None:
        on = self.rb_custom.isChecked()
        self.output_dir_edit.setEnabled(on)
        self.btn_browse.setEnabled(on)

    def _on_restore_dest_toggled(self) -> None:
        on = self.rb_restore_custom.isChecked()
        self.restore_output_dir_edit.setEnabled(on)
        self.btn_restore_browse.setEnabled(on)

    def _browse_dir(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "选择字幕输出目录")
        if folder:
            self.output_dir_edit.setText(folder)

    def _browse_restore_dir(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "选择修复输出目录")
        if folder:
            self.restore_output_dir_edit.setText(folder)

    # Public API -------------------------------------------------------
    def selected_formats(self) -> list[str]:
        return [k for k, cb in self.format_checks.items() if cb.isChecked()]

    def output_dir(self) -> str | None:
        if self.rb_custom.isChecked():
            text = self.output_dir_edit.text().strip()
            return text or None
        return None

    def overwrite(self) -> bool:
        return self.cb_overwrite.isChecked()

    def skip_if_exists(self) -> bool:
        return self.cb_skip_exists.isChecked()

    def lang_tag(self) -> str:
        return self.lang_combo.currentText() or DEFAULT_LANG_TAG

    def restore_output_dir(self) -> str | None:
        if self.rb_restore_custom.isChecked():
            text = self.restore_output_dir_edit.text().strip()
            return text or None
        return None

    def restore_output_pattern(self) -> str:
        return self.restore_pattern_edit.text().strip() or "{original}_restored.mp4"

    def compute_restore_output_path(self, source_path: Path) -> Path:
        out_dir = self.restore_output_dir()
        if not out_dir:
            out_dir = str(source_path.parent)
        pattern = self.restore_output_pattern()
        filename = pattern.replace("{original}", source_path.stem)
        if not filename.endswith((".mp4", ".mkv", ".avi")):
            filename += ".mp4"
        return Path(out_dir) / filename

    # Visibility helpers for workflow modes
    def set_subtitle_section_visible(self, visible: bool) -> None:
        for w in [self.format_checks]:
            pass
        self.cb_overwrite.setVisible(visible)
        # Format checkboxes
        for cb in self.format_checks.values():
            cb.parent().setVisible(visible) if cb.parent() != self else cb.setVisible(visible)
        # We'll handle this at a higher level via the parent widget

    def set_restore_section_visible(self, visible: bool) -> None:
        # Handled at a higher level
        pass

    def to_dict(self) -> dict:
        return {
            "formats": self.selected_formats(),
            "output_dir": self.output_dir_edit.text(),
            "use_custom_dir": self.rb_custom.isChecked(),
            "overwrite": self.overwrite(),
            "skip_if_exists": self.skip_if_exists(),
            "lang_tag": self.lang_tag(),
            "restore_output_dir": self.restore_output_dir_edit.text(),
            "restore_use_custom_dir": self.rb_restore_custom.isChecked(),
            "restore_pattern": self.restore_pattern_edit.text(),
        }

    def from_dict(self, data: dict) -> None:
        if not data:
            return
        formats = data.get("formats")
        if isinstance(formats, list):
            for k, cb in self.format_checks.items():
                cb.setChecked(k in formats)
        if data.get("use_custom_dir"):
            self.rb_custom.setChecked(True)
        if "output_dir" in data:
            self.output_dir_edit.setText(data["output_dir"] or "")
        if "overwrite" in data:
            self.cb_overwrite.setChecked(bool(data["overwrite"]))
        if "skip_if_exists" in data:
            self.cb_skip_exists.setChecked(bool(data["skip_if_exists"]))
        if data.get("lang_tag"):
            i = self.lang_combo.findText(data["lang_tag"])
            if i >= 0:
                self.lang_combo.setCurrentIndex(i)
        if data.get("restore_use_custom_dir"):
            self.rb_restore_custom.setChecked(True)
        if "restore_output_dir" in data:
            self.restore_output_dir_edit.setText(data["restore_output_dir"] or "")
        if "restore_pattern" in data:
            self.restore_pattern_edit.setText(data["restore_pattern"] or "{original}_restored.mp4")
