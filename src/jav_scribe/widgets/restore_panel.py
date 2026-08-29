from __future__ import annotations

from typing import Any

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QComboBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSlider,
    QSpinBox,
    QDoubleSpinBox,
    QStackedWidget,
    QRadioButton,
    QButtonGroup,
    QVBoxLayout,
    QWidget,
    QCheckBox,
)

from ..constants import (
    DETECTION_MODELS,
    DENOISE_STEPS,
    DENOISE_STRENGTHS,
    FILE_CONFLICT_LABELS,
    FILE_CONFLICT_MODES,
    SECONDARY_RESTORATION,
)
from ..core.jasna_presets import read_jasna_presets, read_jasna_last_selected


def _section(title: str) -> tuple[QLabel, QGroupBox]:
    header = QLabel(title)
    header.setStyleSheet("font-weight: bold; color: #0098ff; padding: 0; margin: 0;")
    box = QGroupBox()
    return header, box


class _LabeledSlider(QWidget):
    """QSlider with companion spinbox; both kept in sync."""

    def __init__(self, vmin: float, vmax: float, step: float, value: float, decimals: int = 0):
        super().__init__()
        self.setStyleSheet("background: transparent;")
        self._scale = 10 ** decimals
        self._slider = QSlider(Qt.Horizontal)
        self._slider.setMinimum(int(vmin * self._scale))
        self._slider.setMaximum(int(vmax * self._scale))
        self._slider.setSingleStep(int(step * self._scale))
        self._slider.setValue(int(value * self._scale))

        if decimals > 0:
            self._spin = QDoubleSpinBox()
            self._spin.setDecimals(decimals)
        else:
            self._spin = QSpinBox()
        self._spin.setRange(vmin, vmax)
        self._spin.setSingleStep(step)
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


class _InnerCollapsible(QWidget):
    """Simple collapsible section for sub-groups inside RestorePanel."""

    def __init__(self, title: str, expanded: bool = False, parent=None):
        super().__init__(parent)
        self.setStyleSheet("background: transparent;")
        self._title_text = title
        self._btn = QPushButton(f"{'▼' if expanded else '▶'}  {title}")
        self._btn.setCursor(Qt.PointingHandCursor)
        self._btn.setCheckable(True)
        self._btn.setChecked(expanded)
        self._btn.setStyleSheet(
            "QPushButton {"
            "  text-align: left; font-weight: bold; padding: 4px 2px;"
            "  background-color: transparent; border: none; color: #a0a0a8;"
            "}"
            "QPushButton:hover { color: #c8c8d0; }"
        )

        self._content = QWidget()
        self._content.setStyleSheet("background: transparent;")
        self._content.setVisible(expanded)
        self._content_layout = QVBoxLayout(self._content)
        self._content_layout.setContentsMargins(12, 2, 4, 2)

        self._btn.toggled.connect(self._toggle)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 4, 0, 0)
        outer.setSpacing(2)
        outer.addWidget(self._btn)
        outer.addWidget(self._content)

    def _toggle(self, checked: bool) -> None:
        self._btn.setText(f"{'▼' if checked else '▶'}  {self._title_text}")
        self._content.setVisible(checked)

    def add_widget(self, w: QWidget) -> None:
        self._content_layout.addWidget(w)


class RestorePanel(QWidget):
    """JASNA restoration settings panel with preset support."""

    changed = Signal()

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._presets: dict[str, dict[str, Any]] = {}
        self._build_content()
        self.refresh_presets()

    def _build_content(self) -> None:
        outer = QVBoxLayout()
        outer.setContentsMargins(8, 4, 8, 4)
        outer.setSpacing(8)

        # Preset bar
        preset_row = QHBoxLayout()
        preset_row.addWidget(QLabel("JASNA 预设:"))
        self.preset_combo = QComboBox()
        self.preset_combo.setMinimumWidth(160)
        self.preset_combo.currentTextChanged.connect(self._on_preset_selected)
        preset_row.addWidget(self.preset_combo, 1)
        self.btn_refresh_presets = QPushButton("刷新")
        self.btn_refresh_presets.setMinimumWidth(60)
        self.btn_refresh_presets.clicked.connect(self.refresh_presets)
        preset_row.addWidget(self.btn_refresh_presets)
        outer.addLayout(preset_row)

        # === Basic processing ===
        basic_header, basic_box = _section("基本处理")
        basic_form = QFormLayout(basic_box)
        basic_form.setLabelAlignment(Qt.AlignRight)

        self.max_clip_size = _LabeledSlider(10, 180, 10, 90)
        basic_form.addRow("最大片段大小:", self.max_clip_size)

        self.detection_model = QComboBox()
        self.detection_model.addItems(DETECTION_MODELS)
        basic_form.addRow("检测模型:", self.detection_model)

        self.detection_threshold = _LabeledSlider(0.0, 1.0, 0.05, 0.25, decimals=2)
        basic_form.addRow("检测阈值:", self.detection_threshold)

        self.fp16_mode = QCheckBox("FP16 模式")
        self.fp16_mode.setChecked(True)
        self.fp16_mode.setStyleSheet("background: transparent;")
        basic_form.addRow(self.fp16_mode)

        self.compile_basicvsrpp = QCheckBox("编译 BasicVSR++")
        self.compile_basicvsrpp.setChecked(True)
        self.compile_basicvsrpp.setStyleSheet("background: transparent;")
        basic_form.addRow(self.compile_basicvsrpp)

        self.file_conflict = QComboBox()
        for mode in FILE_CONFLICT_MODES:
            self.file_conflict.addItem(FILE_CONFLICT_LABELS[mode], mode)
        basic_form.addRow("文件冲突:", self.file_conflict)

        outer.addWidget(basic_header)
        outer.addWidget(basic_box)

        # === Advanced processing (collapsed) ===
        adv_section = _InnerCollapsible("高级处理", expanded=False)

        adv_box = QGroupBox()
        adv_form = QFormLayout(adv_box)
        adv_form.setLabelAlignment(Qt.AlignRight)

        self.temporal_overlap = _LabeledSlider(0, 30, 1, 8)
        adv_form.addRow("时序重叠:", self.temporal_overlap)

        self.enable_crossfade = QCheckBox("交叉淡入")
        self.enable_crossfade.setChecked(True)
        self.enable_crossfade.setStyleSheet("background: transparent;")
        adv_form.addRow(self.enable_crossfade)

        self.denoise_strength = QComboBox()
        self.denoise_strength.addItems(DENOISE_STRENGTHS)
        adv_form.addRow("降噪强度:", self.denoise_strength)

        self.denoise_step = QComboBox()
        self.denoise_step.addItems(DENOISE_STEPS)
        adv_form.addRow("降噪步骤:", self.denoise_step)

        adv_section.add_widget(adv_box)
        outer.addWidget(adv_section)

        # === Secondary restoration (collapsed) ===
        sec_section = _InnerCollapsible("二次修复", expanded=False)

        self.secondary_group = QButtonGroup(self)
        self.secondary_radios: dict[str, QRadioButton] = {}
        sec_radio_layout = QVBoxLayout()
        for key in SECONDARY_RESTORATION:
            label = {"none": "无", "unet-4x": "UNet-4x", "tvai": "TVAI", "rtx-super-res": "RTX Super Res"}[key]
            rb = QRadioButton(label)
            rb.setChecked(key == "none")
            self.secondary_group.addButton(rb)
            self.secondary_radios[key] = rb
            sec_radio_layout.addWidget(rb)

        # TVAI sub-panel
        tvai_header, self.tvai_panel = _section("TVAI 设置")
        tvai_form = QFormLayout(self.tvai_panel)
        tvai_form.setLabelAlignment(Qt.AlignRight)
        self.tvai_model = QComboBox()
        self.tvai_model.addItems(["iris-2", "iris-3", "prob-4", "nyx-1"])
        tvai_form.addRow("模型:", self.tvai_model)
        self.tvai_scale = QComboBox()
        self.tvai_scale.addItems(["1", "2", "4"])
        self.tvai_scale.setCurrentText("4")
        tvai_form.addRow("缩放:", self.tvai_scale)
        self.tvai_workers = _LabeledSlider(1, 8, 1, 2)
        tvai_form.addRow("工作线程:", self.tvai_workers)
        tvai_header.setVisible(False)
        self.tvai_panel.setVisible(False)
        sec_radio_layout.addWidget(tvai_header)
        sec_radio_layout.addWidget(self.tvai_panel)

        # RTX sub-panel
        rtx_header, self.rtx_panel = _section("RTX Super Res 设置")
        rtx_form = QFormLayout(self.rtx_panel)
        rtx_form.setLabelAlignment(Qt.AlignRight)
        self.rtx_scale = QComboBox()
        self.rtx_scale.addItems(["2", "4"])
        self.rtx_scale.setCurrentText("4")
        rtx_form.addRow("缩放:", self.rtx_scale)
        self.rtx_quality = QComboBox()
        self.rtx_quality.addItems(["low", "medium", "high", "ultra"])
        self.rtx_quality.setCurrentText("high")
        rtx_form.addRow("质量:", self.rtx_quality)
        rtx_header.setVisible(False)
        self.rtx_panel.setVisible(False)
        sec_radio_layout.addWidget(rtx_header)
        sec_radio_layout.addWidget(self.rtx_panel)

        self.secondary_radios["tvai"].toggled.connect(
            lambda c: (tvai_header.setVisible(c), self.tvai_panel.setVisible(c))
        )
        self.secondary_radios["rtx-super-res"].toggled.connect(
            lambda c: (rtx_header.setVisible(c), self.rtx_panel.setVisible(c))
        )

        sec_widget = QWidget()
        sec_widget.setStyleSheet("background: transparent;")
        sec_widget.setLayout(sec_radio_layout)
        sec_section.add_widget(sec_widget)
        outer.addWidget(sec_section)

        # === Encoding settings (collapsed) ===
        enc_section = _InnerCollapsible("编码设置", expanded=False)

        enc_box = QGroupBox()
        enc_form = QFormLayout(enc_box)
        enc_form.setLabelAlignment(Qt.AlignRight)

        self.encoder_cq = _LabeledSlider(15, 35, 1, 22)
        enc_form.addRow("质量 CQ:", self.encoder_cq)

        self.encoder_custom_args = QLineEdit()
        self.encoder_custom_args.setPlaceholderText('例如: {"preset":"p5","cq":20}')
        enc_form.addRow("自定义编码参数:", self.encoder_custom_args)

        enc_section.add_widget(enc_box)
        outer.addWidget(enc_section)

        # Wire changed signals
        for w in [self.max_clip_size, self.detection_threshold, self.temporal_overlap,
                  self.encoder_cq, self.tvai_workers]:
            w._spin.valueChanged.connect(self.changed)
        for w in [self.detection_model, self.denoise_strength, self.denoise_step,
                  self.file_conflict, self.tvai_model, self.tvai_scale,
                  self.rtx_scale, self.rtx_quality]:
            w.currentIndexChanged.connect(self.changed)
        for rb in self.secondary_radios.values():
            rb.toggled.connect(self.changed)
        self.fp16_mode.stateChanged.connect(self.changed)
        self.compile_basicvsrpp.stateChanged.connect(self.changed)
        self.enable_crossfade.stateChanged.connect(self.changed)
        self.encoder_custom_args.textChanged.connect(self.changed)

        self.setLayout(outer)

    # ----- Preset management -----
    def refresh_presets(self) -> None:
        self._presets = read_jasna_presets()
        self.preset_combo.blockSignals(True)
        self.preset_combo.clear()
        if self._presets:
            self.preset_combo.addItems(sorted(self._presets.keys()))
            last = read_jasna_last_selected()
            idx = self.preset_combo.findText(last)
            if idx >= 0:
                self.preset_combo.setCurrentIndex(idx)
            self._apply_preset(self.preset_combo.currentText())
        else:
            self.preset_combo.addItem("(未找到 JASNA 配置)")
        self.preset_combo.blockSignals(False)

    def _on_preset_selected(self, name: str) -> None:
        self._apply_preset(name)

    def _apply_preset(self, name: str) -> None:
        settings = self._presets.get(name)
        if not settings:
            return

        self.blockSignals(True)

        self.max_clip_size.setValue(settings.get("max_clip_size", 90))

        dm = settings.get("detection_model", "rfdetr-v5")
        idx = self.detection_model.findText(dm)
        if idx >= 0:
            self.detection_model.setCurrentIndex(idx)

        self.detection_threshold.setValue(settings.get("detection_score_threshold", 0.25))
        self.fp16_mode.setChecked(settings.get("fp16_mode", True))
        self.compile_basicvsrpp.setChecked(settings.get("compile_basicvsrpp", True))

        fc = settings.get("file_conflict", "auto_rename")
        idx = self.file_conflict.findData(fc)
        if idx >= 0:
            self.file_conflict.setCurrentIndex(idx)

        self.temporal_overlap.setValue(settings.get("temporal_overlap", 8))
        self.enable_crossfade.setChecked(settings.get("enable_crossfade", True))

        ds = settings.get("denoise_strength", "none")
        idx = self.denoise_strength.findText(ds)
        if idx >= 0:
            self.denoise_strength.setCurrentIndex(idx)

        dstep = settings.get("denoise_step", "after_primary")
        idx = self.denoise_step.findText(dstep)
        if idx >= 0:
            self.denoise_step.setCurrentIndex(idx)

        sr = settings.get("secondary_restoration", "none")
        if sr in self.secondary_radios:
            self.secondary_radios[sr].setChecked(True)

        self.encoder_cq.setValue(settings.get("encoder_cq", 22))
        self.encoder_custom_args.setText(settings.get("encoder_custom_args", ""))

        tm = settings.get("tvai_model", "iris-2")
        idx = self.tvai_model.findText(tm)
        if idx >= 0:
            self.tvai_model.setCurrentIndex(idx)

        self.tvai_scale.setCurrentText(str(settings.get("tvai_scale", 4)))
        self.tvai_workers.setValue(settings.get("tvai_workers", 2))
        self.rtx_scale.setCurrentText(str(settings.get("rtx_scale", 4)))

        rq = settings.get("rtx_quality", "high")
        idx = self.rtx_quality.findText(rq)
        if idx >= 0:
            self.rtx_quality.setCurrentIndex(idx)

        self.blockSignals(False)
        self.changed.emit()

    # ----- CLI projection -----
    def to_cli_args(self) -> dict[str, Any]:
        args: dict[str, Any] = {}
        args["max-clip-size"] = int(self.max_clip_size.value())
        args["detection-model"] = self.detection_model.currentText()
        args["detection-score-threshold"] = round(self.detection_threshold.value(), 2)
        args["fp16"] = self.fp16_mode.isChecked()
        args["compile-basicvsrpp"] = self.compile_basicvsrpp.isChecked()

        args["temporal-overlap"] = int(self.temporal_overlap.value())
        args["enable-crossfade"] = self.enable_crossfade.isChecked()

        ds = self.denoise_strength.currentText()
        if ds != "none":
            args["denoise"] = ds
        args["denoise-step"] = self.denoise_step.currentText()

        for key, rb in self.secondary_radios.items():
            if rb.isChecked() and key != "none":
                args["secondary-restoration"] = key
                break

        args["encoder-settings"] = f'{{"cq":{int(self.encoder_cq.value())}}}'
        custom = self.encoder_custom_args.text().strip()
        if custom:
            args["encoder-settings"] = custom

        sr = self._selected_secondary()
        if sr == "tvai":
            args["tvai-model"] = self.tvai_model.currentText()
            args["tvai-scale"] = int(self.tvai_scale.currentText())
            args["tvai-workers"] = int(self.tvai_workers.value())
        elif sr == "rtx-super-res":
            args["rtx-scale"] = int(self.rtx_scale.currentText())
            args["rtx-quality"] = self.rtx_quality.currentText()

        return args

    def _selected_secondary(self) -> str:
        for key, rb in self.secondary_radios.items():
            if rb.isChecked():
                return key
        return "none"

    # ----- Persistence -----
    def to_dict(self) -> dict:
        return {
            "preset_name": self.preset_combo.currentText(),
            "max_clip_size": int(self.max_clip_size.value()),
            "detection_model": self.detection_model.currentText(),
            "detection_threshold": round(self.detection_threshold.value(), 2),
            "fp16_mode": self.fp16_mode.isChecked(),
            "compile_basicvsrpp": self.compile_basicvsrpp.isChecked(),
            "file_conflict": self.file_conflict.currentData(),
            "temporal_overlap": int(self.temporal_overlap.value()),
            "enable_crossfade": self.enable_crossfade.isChecked(),
            "denoise_strength": self.denoise_strength.currentText(),
            "denoise_step": self.denoise_step.currentText(),
            "secondary_restoration": self._selected_secondary(),
            "encoder_cq": int(self.encoder_cq.value()),
            "encoder_custom_args": self.encoder_custom_args.text(),
        }

    def from_dict(self, data: dict) -> None:
        if not data:
            return
        self.blockSignals(True)

        if "max_clip_size" in data:
            self.max_clip_size.setValue(data["max_clip_size"])
        if "detection_model" in data:
            idx = self.detection_model.findText(data["detection_model"])
            if idx >= 0:
                self.detection_model.setCurrentIndex(idx)
        if "detection_threshold" in data:
            self.detection_threshold.setValue(data["detection_threshold"])
        if "fp16_mode" in data:
            self.fp16_mode.setChecked(data["fp16_mode"])
        if "compile_basicvsrpp" in data:
            self.compile_basicvsrpp.setChecked(data["compile_basicvsrpp"])
        if "file_conflict" in data:
            idx = self.file_conflict.findData(data["file_conflict"])
            if idx >= 0:
                self.file_conflict.setCurrentIndex(idx)
        if "temporal_overlap" in data:
            self.temporal_overlap.setValue(data["temporal_overlap"])
        if "enable_crossfade" in data:
            self.enable_crossfade.setChecked(data["enable_crossfade"])
        if "denoise_strength" in data:
            idx = self.denoise_strength.findText(data["denoise_strength"])
            if idx >= 0:
                self.denoise_strength.setCurrentIndex(idx)
        if "denoise_step" in data:
            idx = self.denoise_step.findText(data["denoise_step"])
            if idx >= 0:
                self.denoise_step.setCurrentIndex(idx)
        if "secondary_restoration" in data:
            sr = data["secondary_restoration"]
            if sr in self.secondary_radios:
                self.secondary_radios[sr].setChecked(True)
        if "encoder_cq" in data:
            self.encoder_cq.setValue(data["encoder_cq"])
        if "encoder_custom_args" in data:
            self.encoder_custom_args.setText(data["encoder_custom_args"])

        if "preset_name" in data:
            idx = self.preset_combo.findText(data["preset_name"])
            if idx >= 0:
                self.preset_combo.setCurrentIndex(idx)

        self.blockSignals(False)
