from __future__ import annotations

from typing import Any

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QSlider,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)
from PySide6.QtCore import Qt

from ..constants import COMPUTE_TYPES, LOG_LEVELS


def _section(title: str) -> tuple[QLabel, QGroupBox]:
    """Create a section header label + titleless card groupbox."""
    header = QLabel(title)
    header.setStyleSheet("font-weight: bold; color: #0098ff; padding: 0; margin: 0;")
    box = QGroupBox()
    return header, box


class _LabeledSlider(QWidget):
    """QSlider with companion double spinbox; both kept in sync."""

    def __init__(self, vmin: float, vmax: float, step: float, value: float, decimals: int = 2):
        super().__init__()
        self.setStyleSheet("background: transparent;")
        self._scale = 10**decimals
        self._slider = QSlider(Qt.Horizontal)
        self._slider.setMinimum(int(vmin * self._scale))
        self._slider.setMaximum(int(vmax * self._scale))
        self._slider.setSingleStep(int(step * self._scale))
        self._slider.setValue(int(value * self._scale))

        self._spin = QDoubleSpinBox()
        self._spin.setRange(vmin, vmax)
        self._spin.setSingleStep(step)
        self._spin.setDecimals(decimals)
        self._spin.setValue(value)

        self._slider.valueChanged.connect(self._on_slider)
        self._spin.valueChanged.connect(self._on_spin)

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(self._slider, 1)
        lay.addWidget(self._spin)

    def _on_slider(self, v: int) -> None:
        self._spin.blockSignals(True)
        self._spin.setValue(v / self._scale)
        self._spin.blockSignals(False)

    def _on_spin(self, v: float) -> None:
        self._slider.blockSignals(True)
        self._slider.setValue(int(v * self._scale))
        self._slider.blockSignals(False)

    def value(self) -> float:
        return self._spin.value()

    def setValue(self, v: float) -> None:
        self._spin.setValue(v)


class AdvancedPanel(QWidget):
    changed = Signal()

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._build_content()

    def _build_content(self) -> None:
        outer = QVBoxLayout()
        outer.setContentsMargins(8, 4, 8, 4)
        outer.setSpacing(8)

        # ---- VAD group --------------------------------------------------
        vad_header, vad_box = _section("VAD (语音活动检测)")
        vad_form = QFormLayout(vad_box)
        vad_form.setLabelAlignment(Qt.AlignRight)

        self.vad_threshold = _LabeledSlider(0.1, 0.9, 0.05, 0.5, decimals=2)
        self.vad_min_speech = QSpinBox()
        self.vad_min_speech.setRange(0, 5000)
        self.vad_min_speech.setSingleStep(50)
        self.vad_min_speech.setValue(300)
        self.vad_min_speech.setSuffix(" ms")

        self.vad_min_silence = QSpinBox()
        self.vad_min_silence.setRange(0, 5000)
        self.vad_min_silence.setSingleStep(50)
        self.vad_min_silence.setValue(100)
        self.vad_min_silence.setSuffix(" ms")

        self.vad_pad = QSpinBox()
        self.vad_pad.setRange(0, 2000)
        self.vad_pad.setSingleStep(50)
        self.vad_pad.setValue(200)
        self.vad_pad.setSuffix(" ms")

        vad_form.addRow("阈值 (0.3–0.7):", self.vad_threshold)
        vad_form.addRow("最小语音时长:", self.vad_min_speech)
        vad_form.addRow("最小静音时长:", self.vad_min_silence)
        vad_form.addRow("前后填充:", self.vad_pad)

        # ---- Segment merge group ---------------------------------------
        merge_header, merge_box = _section("字幕合并 (segment_merge)")
        merge_form = QFormLayout(merge_box)
        merge_form.setLabelAlignment(Qt.AlignRight)

        self.merge_mode = QComboBox()
        self.merge_mode.addItems(["跟随配置文件", "强制启用", "强制禁用"])

        self.merge_max_gap = QSpinBox()
        self.merge_max_gap.setRange(0, 20000)
        self.merge_max_gap.setSingleStep(100)
        self.merge_max_gap.setValue(0)
        self.merge_max_gap.setSpecialValueText("(默认 2000)")
        self.merge_max_gap.setSuffix(" ms")

        self.merge_max_dur = QSpinBox()
        self.merge_max_dur.setRange(0, 120000)
        self.merge_max_dur.setSingleStep(1000)
        self.merge_max_dur.setValue(0)
        self.merge_max_dur.setSpecialValueText("(默认 20000)")
        self.merge_max_dur.setSuffix(" ms")

        merge_form.addRow("合并模式:", self.merge_mode)
        merge_form.addRow("最大间隔 (max_gap_ms):", self.merge_max_gap)
        merge_form.addRow("最大时长 (max_duration_ms):", self.merge_max_dur)

        # ---- Inference group ------------------------------------------
        infer_header, infer_box = _section("推理 (compute / batch / log)")
        infer_form = QFormLayout(infer_box)
        infer_form.setLabelAlignment(Qt.AlignRight)

        self.compute_type = QComboBox()
        self.compute_type.addItems(COMPUTE_TYPES)

        self.enable_batching = QCheckBox("启用批处理 (--enable_batching)")
        self.enable_batching.setStyleSheet("background: transparent;")
        self.batch_size = QSpinBox()
        self.batch_size.setRange(0, 32)
        self.batch_size.setSpecialValueText("自动")
        self.batch_size.setValue(0)
        self.max_batch_size = QSpinBox()
        self.max_batch_size.setRange(1, 32)
        self.max_batch_size.setValue(8)

        self.log_level = QComboBox()
        self.log_level.addItems(LOG_LEVELS)
        # DEBUG is the GUI default: infer.exe emits per-segment timestamps
        # (`[mm:ss --> mm:ss] ...`) and translation text at DEBUG level only.
        # Without these, the progress bar can't advance and the log view looks empty.
        self.log_level.setCurrentText("DEBUG")

        infer_form.addRow("计算类型:", self.compute_type)
        infer_form.addRow(self.enable_batching)
        infer_form.addRow("batch_size:", self.batch_size)
        infer_form.addRow("max_batch_size:", self.max_batch_size)
        infer_form.addRow("日志级别:", self.log_level)

        # Wire up changed signals -----------------------------------------
        for w in [
            self.vad_min_speech,
            self.vad_min_silence,
            self.vad_pad,
            self.merge_max_gap,
            self.merge_max_dur,
            self.batch_size,
            self.max_batch_size,
        ]:
            w.valueChanged.connect(self.changed)
        for w in [self.merge_mode, self.compute_type, self.log_level]:
            w.currentIndexChanged.connect(self.changed)
        self.enable_batching.stateChanged.connect(self.changed)
        self.vad_threshold._spin.valueChanged.connect(self.changed)

        outer.addWidget(vad_header)
        outer.addWidget(vad_box)
        outer.addWidget(merge_header)
        outer.addWidget(merge_box)
        outer.addWidget(infer_header)
        outer.addWidget(infer_box)

        self.setLayout(outer)

    # ----- CLI projection -----
    def to_cli_args(self) -> dict[str, Any]:
        args: dict[str, Any] = {
            "vad_threshold": round(self.vad_threshold.value(), 3),
            "vad_min_speech_duration_ms": self.vad_min_speech.value(),
            "vad_min_silence_duration_ms": self.vad_min_silence.value(),
            "vad_speech_pad_ms": self.vad_pad.value(),
            "compute_type": self.compute_type.currentText(),
            "log_level": self.log_level.currentText(),
        }

        merge_mode = self.merge_mode.currentText()
        if merge_mode == "强制启用":
            args["merge_segments"] = True
        elif merge_mode == "强制禁用":
            args["no_merge_segments"] = True

        if self.merge_max_gap.value() > 0:
            args["merge_max_gap_ms"] = self.merge_max_gap.value()
        if self.merge_max_dur.value() > 0:
            args["merge_max_duration_ms"] = self.merge_max_dur.value()

        if self.enable_batching.isChecked():
            args["enable_batching"] = True
            if self.batch_size.value() > 0:
                args["batch_size"] = self.batch_size.value()
            args["max_batch_size"] = self.max_batch_size.value()

        return args

    def to_dict(self) -> dict:
        return {
            "vad_threshold": self.vad_threshold.value(),
            "vad_min_speech": self.vad_min_speech.value(),
            "vad_min_silence": self.vad_min_silence.value(),
            "vad_pad": self.vad_pad.value(),
            "merge_mode": self.merge_mode.currentIndex(),
            "merge_max_gap": self.merge_max_gap.value(),
            "merge_max_dur": self.merge_max_dur.value(),
            "compute_type": self.compute_type.currentText(),
            "enable_batching": self.enable_batching.isChecked(),
            "batch_size": self.batch_size.value(),
            "max_batch_size": self.max_batch_size.value(),
            "log_level": self.log_level.currentText(),
        }

    def from_dict(self, data: dict) -> None:
        if not data:
            return
        if "vad_threshold" in data:
            self.vad_threshold.setValue(float(data["vad_threshold"]))
        if "vad_min_speech" in data:
            self.vad_min_speech.setValue(int(data["vad_min_speech"]))
        if "vad_min_silence" in data:
            self.vad_min_silence.setValue(int(data["vad_min_silence"]))
        if "vad_pad" in data:
            self.vad_pad.setValue(int(data["vad_pad"]))
        if "merge_mode" in data:
            self.merge_mode.setCurrentIndex(int(data["merge_mode"]))
        if "merge_max_gap" in data:
            self.merge_max_gap.setValue(int(data["merge_max_gap"]))
        if "merge_max_dur" in data:
            self.merge_max_dur.setValue(int(data["merge_max_dur"]))
        if "compute_type" in data:
            i = self.compute_type.findText(data["compute_type"])
            if i >= 0:
                self.compute_type.setCurrentIndex(i)
        if "enable_batching" in data:
            self.enable_batching.setChecked(bool(data["enable_batching"]))
        if "batch_size" in data:
            self.batch_size.setValue(int(data["batch_size"]))
        if "max_batch_size" in data:
            self.max_batch_size.setValue(int(data["max_batch_size"]))
        if "log_level" in data:
            i = self.log_level.findText(data["log_level"])
            if i >= 0:
                self.log_level.setCurrentIndex(i)
