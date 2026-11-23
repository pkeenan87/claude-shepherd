// shepherd-viewer: native GPUI Markdown viewer for shepherd plans and review reports.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { checking, closeOverlay, props, readTextFile, theme } from "herdr";

export default class ShepherdViewer extends View {
  init(p, cx) {
    this.file = p?.file ?? props()?.file ?? "";
    this.machine = p?.on ?? props()?.on ?? null;
    this.docKey = `${this.machine ?? ""}:${this.file}`;
    this.content = null;
    this.error = null;
    this.loading = false;
    if (checking()) return;
    this.reload(cx);
  }

  reload(cx) {
    if (!this.file) {
      this.error = "No file specified.";
      cx.notify();
      return;
    }
    this.loading = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.file, this.machine ? { on: this.machine } : undefined);
        if (text === null) {
          this.error = `File not found: ${this.file}`;
          this.content = null;
        } else {
          this.content = text;
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  btn(id, label, t, onClick) {
    return div()
      .id(id)
      .px(8)
      .py(3)
      .rounded(4)
      .bg(t.raised)
      .text_size(11)
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(label);
  }

  render(cx) {
    const t = theme();
    const p = props();
    const nextFile = p?.file ?? "";
    const nextMachine = p?.on ?? null;
    const nextKey = `${nextMachine ?? ""}:${nextFile}`;
    if (nextFile && nextKey !== this.docKey && !this.loading) {
      this.file = nextFile;
      this.machine = nextMachine;
      this.docKey = nextKey;
      this.content = null;
      this.error = null;
      this.reload(cx);
    }
    const overlayId = p?.overlay ?? null;
    const baseName = this.file ? this.file.split("/").pop() : "shepherd viewer";
    return v_flex()
      .id("shepherd-viewer")
      .size_full()
      .bg(t.surface)
      .text_color(t.foreground)
      .text_size(12)
      .child(
        h_flex()
          .gap(8)
          .px(12)
          .py(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome ?? t.surface)
          .child(div().font_semibold().text_size(13).child(baseName))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.file || ""))
          .child(this.btn("sv-refresh", this.loading ? "…" : "↻", t, (_e, cx) => this.reload(cx)))
          .when(!!overlayId, (el) =>
            el.child(this.btn("sv-close", "✕", t, () => closeOverlay(overlayId))),
          ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .p(14)
          .overflow_y_scrollbar()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .when(!!this.error, (el) =>
            el.child(div().p(10).rounded(6).bg(t.raised).border(1).border_color(t.blocked).text_color(t.blocked).child(this.error)),
          )
          .when(!this.error && this.content === null, (el) =>
            el.child(div().text_color(t.muted).child(this.loading ? "Loading document…" : "No content.")),
          )
          .when(!this.error && typeof this.content === "string", (el) =>
            el.child(TextView.markdown("shepherd-viewer-md", this.content).selectable(true).scrollable(false)),
          ),
      );
  }
}
