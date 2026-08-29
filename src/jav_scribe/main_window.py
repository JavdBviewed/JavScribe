from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QCloseEvent
from PySide6.QtWidgets import (
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSplitter,
    QStatusBar,
    QStyle,
    QTabWidget,
    QToolBar,
    QVBoxLayout,
    QWidget,
)

from .constants import ALL_EXTS, APP_NAME, APP_VERSION
from .core import settings as settings_io
from .core.infer_runner import InferRunner
from .core.jasna_runner import JasnaRunner
from .core.task_model import TaskPhase, TaskStatus, TaskTableModel
from .widgets.advanced_panel import AdvancedPanel
from .widgets.drop_area import DropArea
from .widgets.log_view import LogView
from .widgets.mode_bar import ModeBar, scan_models
from .widgets.output_settings import OutputSettings
from .widgets.restore_panel import RestorePanel
from .widgets.task_table import TaskTableView
from .widgets.workflow_bar import WorkflowBar


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle(f"{APP_NAME}  v{APP_VERSION}")
        self.resize(1280, 800)

        self._settings = settings_io.load()
        self._infer_exe: Path | None = self._resolve_infer_exe()
        self._jasna_cli_exe: Path | None = self._resolve_jasna_cli_exe()

        self.task_model = TaskTableModel()
        self.infer_runner: InferRunner | None = None
        self.jasna_runner: JasnaRunner | None = None

        self._expected_formats: set[str] = set()
        self._written_by_stem: dict[str, list[Path]] = {}

        self._current_task_idx: int = -1
        self._stopping: bool = False

        self._build_ui()
        self._wire_signals()
        self._load_persisted_state()
        self._refresh_models()
        self._update_status()
        self._update_panel_visibility()

    def _resolve_infer_exe(self) -> Path | None:
        saved = self._settings.get("infer_exe")
        if saved and Path(saved).exists():
            return Path(saved)
        guess = Path(sys.argv[0]).resolve().parent / "infer.exe"
        if guess.exists():
            return guess
        cwd_guess = Path.cwd() / "infer.exe"
        if cwd_guess.exists():
            return cwd_guess
        return None

    def _resolve_jasna_cli_exe(self) -> Path | None:
        saved = self._settings.get("jasna_cli_exe")
        if saved and Path(saved).exists():
            return Path(saved)
        return None

    # ------------------------------------------------------------------
    def _build_ui(self) -> None:
        toolbar = QToolBar("主工具栏")
        toolbar.setMovable(False)
        self.addToolBar(toolbar)
        self.act_pick_infer = QAction("设置 infer.exe…", self)
        self.act_pick_infer.triggered.connect(self._pick_infer_exe)
        self.act_pick_jasna = QAction("设置 jasna-cli.exe…", self)
        self.act_pick_jasna.triggered.connect(self._pick_jasna_cli_exe)
        self.act_about = QAction("关于", self)
        self.act_about.triggered.connect(self._show_about)
        toolbar.addAction(self.act_pick_infer)
        toolbar.addAction(self.act_pick_jasna)
        toolbar.addAction(self.act_about)

        # Central splitter: left (60%) | right (40%)
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)
        root.setContentsMargins(8, 8, 8, 8)
        root.setSpacing(0)

        splitter = QSplitter(Qt.Horizontal)
        root.addWidget(splitter)

        # ==================== LEFT PANEL ====================
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 8, 0)
        left_layout.setSpacing(12)

        self.workflow_bar = WorkflowBar()
        left_layout.addWidget(self.workflow_bar)

        self.drop_area = DropArea()
        left_layout.addWidget(self.drop_area)

        # Action buttons
        action_row = QHBoxLayout()
        self.btn_start = QPushButton(" 开始执行")
        self.btn_start.setObjectName("btn_start")
        self.btn_stop = QPushButton(" 停止")
        self.btn_stop.setObjectName("btn_stop")
        self.btn_clear = QPushButton("清空")
        self.btn_remove = QPushButton("移除所选")
        self.btn_stop.setEnabled(False)
        action_row.addWidget(self.btn_start)
        action_row.addWidget(self.btn_stop)
        action_row.addSpacing(16)
        action_row.addWidget(self.btn_remove)
        action_row.addWidget(self.btn_clear)
        action_row.addStretch(1)
        left_layout.addLayout(action_row)

        self.task_table = TaskTableView(self.task_model)
        self.task_table.setMinimumHeight(180)
        left_layout.addWidget(self.task_table, 1)

        self.log_view = LogView()
        left_layout.addWidget(self.log_view)

        # ==================== RIGHT PANEL ====================
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(8, 0, 0, 0)
        right_layout.setSpacing(0)

        # Wrap right panel in scroll area for overflow
        right_scroll = QScrollArea()
        right_scroll.setWidgetResizable(True)
        right_scroll.setFrameShape(QFrame.NoFrame)
        right_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)

        right_content = QWidget()
        right_scroll.setWidget(right_content)
        right_scroll_layout = QVBoxLayout(right_content)
        right_scroll_layout.setContentsMargins(0, 0, 0, 0)

        self.config_tabs = QTabWidget()
        right_scroll_layout.addWidget(self.config_tabs)

        # Tab 1: 视频修复 (JASNA)
        self.restore_panel = RestorePanel()
        self.config_tabs.addTab(self._wrap_tab(self.restore_panel), "视频修复")

        # Tab 2: 字幕生成 (Whisper)
        subtitle_tab = QWidget()
        sub_layout = QVBoxLayout(subtitle_tab)
        sub_layout.setContentsMargins(8, 8, 8, 8)
        sub_layout.setSpacing(8)

        self.mode_bar = ModeBar()
        sub_layout.addWidget(self.mode_bar)

        self.advanced = AdvancedPanel()
        sub_layout.addWidget(self.advanced)

        sub_layout.addStretch(1)
        self.config_tabs.addTab(subtitle_tab, "字幕生成")

        # Tab 3: 输出设置
        self.output_settings = OutputSettings()
        self.config_tabs.addTab(self._wrap_tab(self.output_settings), "输出设置")

        right_layout.addWidget(right_scroll)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setStretchFactor(0, 6)
        splitter.setStretchFactor(1, 4)
        splitter.setSizes([720, 480])

        # Status bar
        self.setStatusBar(QStatusBar())
        self.lbl_status = QLabel()
        self.statusBar().addPermanentWidget(self.lbl_status)

    def _wrap_tab(self, widget: QWidget) -> QWidget:
        """Wrap a tab widget with padding."""
        padded = QWidget()
        padded.setStyleSheet("background: transparent;")
        lay = QVBoxLayout(padded)
        lay.setContentsMargins(8, 8, 8, 8)
        lay.addWidget(widget)
        lay.addStretch(1)
        return padded

    # ------------------------------------------------------------------
    def _wire_signals(self) -> None:
        self.drop_area.paths_added.connect(self._on_paths_added)
        self.btn_start.clicked.connect(self._on_start)
        self.btn_stop.clicked.connect(self._on_stop)
        self.btn_clear.clicked.connect(self.task_model.clear_all)
        self.btn_remove.clicked.connect(self._remove_selected)

        self.task_table.open_output_requested.connect(self._open_output_for_row)
        self.task_table.open_source_requested.connect(self._open_source_for_row)
        self.task_table.remove_requested.connect(self.task_model.remove_row)

        self.mode_bar.refresh_models.connect(self._refresh_models)
        self.workflow_bar.mode_changed.connect(self._on_workflow_mode_changed)

    # ------------------------------------------------------------------
    def _load_persisted_state(self) -> None:
        self.workflow_bar.from_dict(self._settings.get("workflow_bar", {}))
        self.mode_bar.from_dict(self._settings.get("mode_bar", {}))
        self.output_settings.from_dict(self._settings.get("output_settings", {}))
        self.advanced.from_dict(self._settings.get("advanced", {}))
        self.restore_panel.from_dict(self._settings.get("restore_panel", {}))

    def _persist(self) -> None:
        self._settings["workflow_bar"] = self.workflow_bar.to_dict()
        self._settings["mode_bar"] = self.mode_bar.to_dict()
        self._settings["output_settings"] = self.output_settings.to_dict()
        self._settings["advanced"] = self.advanced.to_dict()
        self._settings["restore_panel"] = self.restore_panel.to_dict()
        if self._infer_exe:
            self._settings["infer_exe"] = str(self._infer_exe)
        if self._jasna_cli_exe:
            self._settings["jasna_cli_exe"] = str(self._jasna_cli_exe)
        try:
            settings_io.save(self._settings)
        except OSError as e:
            self.statusBar().showMessage(f"保存设置失败: {e}", 4000)

    def closeEvent(self, event: QCloseEvent) -> None:
        has_running = (self.infer_runner and self.infer_runner.is_running()) or \
                      (self.jasna_runner and self.jasna_runner.is_running())
        if has_running:
            ret = QMessageBox.question(
                self, "正在运行", "任务正在运行中，确认要退出并终止？",
                QMessageBox.Yes | QMessageBox.No,
            )
            if ret != QMessageBox.Yes:
                event.ignore()
                return
            if self.infer_runner:
                self.infer_runner.stop()
            if self.jasna_runner:
                self.jasna_runner.stop()
        self._persist()
        event.accept()

    # ------------------------------------------------------------------
    def _on_workflow_mode_changed(self, mode: str) -> None:
        self._update_panel_visibility()

    def _update_panel_visibility(self) -> None:
        mode = self.workflow_bar.selected_mode()
        has_restore = mode in ("restore_only", "restore_and_subtitle")
        has_subtitle = mode in ("subtitle_only", "restore_and_subtitle")

        tab_restore = 0
        tab_subtitle = 1
        tab_output = 2

        self.config_tabs.setTabVisible(tab_restore, has_restore)
        self.config_tabs.setTabVisible(tab_subtitle, has_subtitle)

        if has_restore and not self.config_tabs.isTabVisible(tab_restore):
            self.config_tabs.setCurrentIndex(tab_restore)
        elif has_subtitle and not has_restore:
            self.config_tabs.setCurrentIndex(tab_subtitle)

    # ------------------------------------------------------------------
    def _refresh_models(self) -> None:
        if not self._infer_exe:
            self.mode_bar.set_models([("(请先设置 infer.exe)", "models")])
            return
        items = scan_models(self._infer_exe.parent)
        self.mode_bar.set_models(items)

    def _update_status(self) -> None:
        parts = []
        if self._infer_exe:
            parts.append(f"infer.exe: {self._infer_exe}")
        else:
            parts.append("⚠ 未配置 infer.exe")
        if self._jasna_cli_exe:
            parts.append(f"jasna-cli: {self._jasna_cli_exe}")
        else:
            parts.append("⚠ 未配置 jasna-cli.exe")
        self.lbl_status.setText(" | ".join(parts))

    def _pick_infer_exe(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择 infer.exe", "", "可执行文件 (infer.exe);;所有文件 (*.*)"
        )
        if path:
            self._infer_exe = Path(path)
            self._update_status()
            self._refresh_models()
            self._persist()

    def _pick_jasna_cli_exe(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择 jasna-cli.exe", "", "可执行文件 (jasna-cli.exe);;所有文件 (*.*)"
        )
        if path:
            self._jasna_cli_exe = Path(path)
            self._update_status()
            self._persist()

    def _show_about(self) -> None:
        QMessageBox.about(
            self, "关于",
            f"<h3>{APP_NAME} v{APP_VERSION}</h3>"
            "<p>JAV 字幕生成与媒体库联动：<br>"
            "ASR 转录/翻译（海南鸡 Whisper）→ &lt;影片名&gt;.zh.srt 原位落位，"
            "Emby/Jellyfin 扫描即用。支持批量、目录监听、进度查询。</p>"
            "<p>字幕引擎：TransWithAI ChickenRice (MIT)<br>"
            "https://github.com/TransWithAI/Faster-Whisper-TransWithAI-ChickenRice</p>"
            "<p>基于 JAVSubTool (maudslice, MIT)<br>"
            "https://github.com/maudslice/JAVSubTool</p>"
            "<p>修复引擎：JASNA (Kruk2, AGPL-3.0，仅外部调用、不随本软件分发)<br>"
            "https://github.com/Kruk2/jasna</p>",
        )

    # ------------------------------------------------------------------
    def _on_paths_added(self, paths: list[Path]) -> None:
        added = self.task_model.add_paths(list(paths))
        if added:
            self.statusBar().showMessage(f"已加入 {added} 个文件", 3000)
        else:
            self.statusBar().showMessage("没有新文件被加入（可能格式不支持或已存在）", 3000)

    def _remove_selected(self) -> None:
        rows = sorted(
            {idx.row() for idx in self.task_table.selectionModel().selectedRows()},
            reverse=True,
        )
        for r in rows:
            self.task_model.remove_row(r)

    # ==================================================================
    # Workflow orchestration
    # ==================================================================
    def _on_start(self) -> None:
        mode = self.workflow_bar.selected_mode()

        if mode in ("restore_only", "restore_and_subtitle"):
            if not self._jasna_cli_exe or not self._jasna_cli_exe.exists():
                QMessageBox.warning(self, "未配置", "请先设置 jasna-cli.exe 的路径。")
                return

        if mode in ("subtitle_only", "restore_and_subtitle"):
            if not self._infer_exe or not self._infer_exe.exists():
                QMessageBox.warning(self, "未配置", "请先设置 infer.exe 的路径。")
                return
            formats = self.output_settings.selected_formats()
            if not formats:
                QMessageBox.warning(self, "未选格式", "请至少选择一种字幕格式。")
                return

        pending = self.task_model.pending_paths()
        if not pending:
            QMessageBox.information(self, "无任务", "队列里没有待处理的文件。")
            return

        self._stopping = False
        self._written_by_stem = {}
        self._expected_formats = set(self.output_settings.selected_formats()) if \
            mode in ("subtitle_only", "restore_and_subtitle") else set()

        for i, t in enumerate(self.task_model.tasks):
            if t.status == TaskStatus.PENDING:
                self.task_model.update_task(
                    i, status=TaskStatus.RUNNING, phase=TaskPhase.WAITING,
                    progress=0.0, message="排队中",
                )

        self.btn_start.setEnabled(False)
        self.btn_stop.setEnabled(True)
        self._persist()

        self._current_task_idx = -1
        self._start_next_task()

    def _start_next_task(self) -> None:
        if self._stopping:
            self._finish_workflow()
            return

        for i, t in enumerate(self.task_model.tasks):
            if t.status == TaskStatus.RUNNING and t.phase == TaskPhase.WAITING:
                self._current_task_idx = i
                break
        else:
            self._finish_workflow()
            return

        mode = self.workflow_bar.selected_mode()
        task_idx = self._current_task_idx
        done_count = sum(1 for t in self.task_model.tasks if t.status == TaskStatus.DONE)
        running_count = sum(1 for t in self.task_model.tasks if t.status == TaskStatus.RUNNING)
        file_num = done_count + 1
        total = done_count + running_count

        if mode in ("restore_only", "restore_and_subtitle"):
            self._start_restore_stage(task_idx, file_num, total)
        else:
            self._start_subtitle_stage(task_idx, file_num, total)

    def _start_restore_stage(self, task_idx: int, file_num: int, total: int) -> None:
        task = self.task_model.tasks[task_idx]
        output_path = self.output_settings.compute_restore_output_path(task.path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        self.task_model.update_task(
            task_idx, phase=TaskPhase.RESTORING, progress=0.0,
            message=f"修复中 ({file_num}/{total})",
        )

        cli_args = self.restore_panel.to_cli_args()

        fc = self.restore_panel.file_conflict.currentData()
        if fc == "skip" and output_path.exists():
            task.restored_path = output_path
            self.task_model.update_task(
                task_idx, phase=TaskPhase.RESTORED, progress=1.0,
                message="跳过（已存在）",
            )
            self._on_restore_done(task_idx, success=True)
            return

        self.log_view.append_line(
            f"\n===== 修复 {task.path.name} ({file_num}/{total}) ====="
        )

        self.jasna_runner = JasnaRunner(self._jasna_cli_exe)
        self.jasna_runner.log_line.connect(self.log_view.append_line)
        self.jasna_runner.progress.connect(
            lambda p, idx=task_idx: self.task_model.update_task(idx, progress=p)
        )
        self.jasna_runner.status_text.connect(lambda s: self.statusBar().showMessage(s, 5000))
        self.jasna_runner.error.connect(self._on_jasna_error)
        self.jasna_runner.finished.connect(
            lambda code, idx=task_idx, op=output_path: self._on_jasna_finished(idx, op, code)
        )
        self.jasna_runner.start(task.path, output_path, cli_args)

    def _start_subtitle_stage(self, task_idx: int, file_num: int, total: int) -> None:
        task = self.task_model.tasks[task_idx]
        source = task.restored_path if task.restored_path else task.path

        self.task_model.update_task(
            task_idx, phase=TaskPhase.SUBTITLING, progress=0.0,
            message=f"字幕中 ({file_num}/{total})",
        )

        cli_args = self._compose_infer_cli_args()

        self.log_view.append_line(
            f"\n===== 字幕 {source.name} ({file_num}/{total}) ====="
        )

        self.infer_runner = InferRunner(self._infer_exe)
        self.infer_runner.log_line.connect(self.log_view.append_line)
        self.infer_runner.file_started.connect(
            lambda idx, tot, path, ti=task_idx: self._on_infer_file_started(ti, path)
        )
        self.infer_runner.file_progress.connect(
            lambda path, progress, ti=task_idx: self._on_infer_file_progress(ti, progress)
        )
        self.infer_runner.file_written.connect(self._on_infer_file_written)
        self.infer_runner.status_text.connect(lambda s: self.statusBar().showMessage(s, 5000))
        self.infer_runner.error.connect(self._on_infer_error)
        self.infer_runner.finished.connect(
            lambda code, ti=task_idx: self._on_infer_finished(ti, code)
        )
        self.infer_runner.start([source], cli_args)

    def _on_restore_done(self, task_idx: int, success: bool) -> None:
        mode = self.workflow_bar.selected_mode()

        if not success:
            self.task_model.update_task(
                task_idx, status=TaskStatus.ERROR, message="修复失败",
            )
            self._start_next_task()
            return

        if mode == "restore_and_subtitle":
            done_count = sum(1 for t in self.task_model.tasks if t.status == TaskStatus.DONE)
            running_count = sum(1 for t in self.task_model.tasks if t.status == TaskStatus.RUNNING)
            self._start_subtitle_stage(task_idx, done_count + 1, done_count + running_count)
        else:
            self.task_model.update_task(
                task_idx, status=TaskStatus.DONE, phase=TaskPhase.DONE,
                progress=1.0, message="完成",
            )
            self._start_next_task()

    def _on_jasna_error(self, msg: str) -> None:
        self.log_view.append_line(f"[ERROR] {msg}")
        self.statusBar().showMessage(msg, 5000)

    def _on_jasna_finished(self, task_idx: int, output_path: Path, code: int) -> None:
        self.jasna_runner = None
        if code == 0:
            self.task_model.tasks[task_idx].restored_path = output_path
            self.log_view.append_line("===== 修复完成 =====")
            self._on_restore_done(task_idx, success=True)
        else:
            self.log_view.append_line(f"===== 修复失败，退出码 {code} =====")
            self._on_restore_done(task_idx, success=False)

    def _on_infer_file_started(self, task_idx: int, path: str) -> None:
        self.statusBar().showMessage(f"正在翻译: {Path(path).name}", 0)

    def _on_infer_file_progress(self, task_idx: int, progress: float) -> None:
        self.task_model.update_task(task_idx, progress=progress)

    def _on_infer_file_written(self, out_path: str, fmt: str) -> None:
        if not fmt:
            return
        stem = Path(out_path).stem
        p = Path(out_path)
        if p not in self._written_by_stem.setdefault(stem, []):
            self._written_by_stem[stem].append(p)

    def _on_infer_error(self, msg: str) -> None:
        self.log_view.append_line(f"[ERROR] {msg}")
        self.statusBar().showMessage(msg, 5000)

    def _on_infer_finished(self, task_idx: int, code: int) -> None:
        self.infer_runner = None
        task = self.task_model.tasks[task_idx]
        source = task.restored_path if task.restored_path else task.path

        written = {p.suffix.lower().lstrip(".") for p in self._written_by_stem.get(source.stem, [])}
        if not self._expected_formats or self._expected_formats.issubset(written):
            self._finalize_source(source)
            self.task_model.update_task(
                task_idx, status=TaskStatus.DONE, phase=TaskPhase.DONE,
                progress=1.0, message="完成",
            )
        else:
            missing = sorted(self._expected_formats - written)
            msg = f"退出码 {code}"
            if missing:
                msg += f"（缺少 {','.join(missing)}）"
            self.task_model.update_task(
                task_idx, status=TaskStatus.ERROR, phase=TaskPhase.DONE, message=msg,
            )

        self.log_view.append_line(f"===== 字幕完成，退出码 {code} =====\n")
        self._start_next_task()

    def _finalize_source(self, source: Path) -> None:
        """Rename engine output to <stem>.<lang>.srt next to the source
        (media-server friendly). Skipped when a custom output dir is used."""
        if self.output_settings.output_dir():
            return
        from .core.finalize import finalize_one

        sub_cfg = {
            "naming": "rename",
            "lang_tag": self.output_settings.lang_tag(),
            "skip_if_exists": self.output_settings.skip_if_exists(),
            "overwrite": self.output_settings.overwrite(),
            "output_dir": None,
            "tag_formats": ["srt", "vtt"],
        }
        finalize_one(source, self._written_by_stem.get(source.stem, []), sub_cfg,
                     log=self.log_view.append_line)

    def _on_stop(self) -> None:
        self._stopping = True
        if self.jasna_runner:
            self.jasna_runner.stop()
        if self.infer_runner:
            self.infer_runner.stop()
        self.statusBar().showMessage("已请求停止…", 3000)

    def _finish_workflow(self) -> None:
        self.task_model.mark_all_running_as(TaskStatus.CANCELED, "已取消")
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)
        self.statusBar().showMessage("工作流结束", 5000)
        self._current_task_idx = -1

    def _compose_infer_cli_args(self) -> dict[str, Any]:
        args: dict[str, Any] = {}
        args["model_name_or_path"] = self.mode_bar.selected_model_path()
        args["device"] = self.mode_bar.selected_device()
        args["sub_formats"] = ",".join(self.output_settings.selected_formats())
        args["audio_suffixes"] = ",".join(ALL_EXTS)

        out_dir = self.output_settings.output_dir()
        if out_dir:
            args["output_dir"] = out_dir
        if self.output_settings.overwrite():
            args["overwrite"] = True

        preset = self.mode_bar.selected_preset()
        if preset.enable_batching:
            args["enable_batching"] = True
            if preset.max_batch_size:
                args["max_batch_size"] = preset.max_batch_size

        adv = self.advanced.to_cli_args()
        args.update(adv)
        return args

    # ------------------------------------------------------------------
    def _open_output_for_row(self, row: int) -> None:
        if not (0 <= row < len(self.task_model.tasks)):
            return
        t = self.task_model.tasks[row]
        mode = self.workflow_bar.selected_mode()

        if mode in ("restore_only", "restore_and_subtitle") and t.restored_path:
            self._open_in_explorer(t.restored_path.parent)
        else:
            out_dir = self.output_settings.output_dir()
            if out_dir:
                target_dir = Path(out_dir)
                if not target_dir.is_absolute() and self._infer_exe:
                    target_dir = self._infer_exe.parent / out_dir
            else:
                target_dir = t.path.parent
            self._open_in_explorer(target_dir)

    def _open_source_for_row(self, row: int) -> None:
        if not (0 <= row < len(self.task_model.tasks)):
            return
        t = self.task_model.tasks[row]
        self._open_in_explorer(t.path.parent, select=t.path)

    def _open_in_explorer(self, folder: Path, select: Path | None = None) -> None:
        try:
            if sys.platform == "win32":
                if select and select.exists():
                    subprocess.run(["explorer", f"/select,{select}"], check=False)
                else:
                    os.startfile(str(folder))  # noqa: SIM115
            else:
                subprocess.run(["xdg-open", str(folder)], check=False)
        except OSError as e:
            QMessageBox.warning(self, "打开失败", str(e))
