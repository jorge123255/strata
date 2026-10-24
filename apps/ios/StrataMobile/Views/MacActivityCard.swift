import SwiftUI

struct MacActivityCard: View {
    let tool: MacToolActivity
    let awaitingApproval: Bool
    let deciding: Bool
    let decide: (Bool) -> Void
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            Button { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { expanded.toggle() } } label: {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: tool.icon).font(.subheadline).foregroundStyle(awaitingApproval ? StrataTheme.warning : StrataTheme.ink).frame(width: 32, height: 32).background(awaitingApproval ? StrataTheme.warningTint : StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(tool.title).font(.subheadline.weight(.medium)).foregroundStyle(StrataTheme.ink).multilineTextAlignment(.leading)
                        Text(tool.statusLabel).font(.caption2).foregroundStyle(tool.state == "error" ? StrataTheme.warning : StrataTheme.secondaryInk)
                    }
                    Spacer(minLength: 3)
                    if tool.isRunning { ProgressView().controlSize(.mini).tint(StrataTheme.accentText) }
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(StrataTheme.secondaryInk)
                }
                .frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("macActivity-" + tool.id)
            .accessibilityLabel(tool.title + ", " + tool.statusLabel + (expanded ? ", hide details" : ", show details"))

            if let target = tool.target, !target.isEmpty {
                Text(target).font(.caption.monospaced()).foregroundStyle(StrataTheme.secondaryInk)
                    .lineLimit(expanded ? nil : 2).textSelection(.enabled)
                    .accessibilityIdentifier(tool.isBrowser ? "browserActivityTarget" : "toolActivityTarget")
            }
            if expanded {
                details
                if let url = tool.browserURL {
                    Link(destination: url) { Label("Open page on iPhone", systemImage: "arrow.up.right.square").font(.caption.weight(.semibold)) }
                        .foregroundStyle(StrataTheme.accentText)
                }
            }
            if awaitingApproval {
                if let why = tool.ask?.why, !why.isEmpty { Text(why).font(.caption).foregroundStyle(StrataTheme.ink) }
                if let detail = tool.ask?.detail, !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(StrataTheme.secondaryInk).textSelection(.enabled) }
                Text("This allows the action on your Mac.").font(.caption2).foregroundStyle(StrataTheme.secondaryInk)
                HStack(spacing: 10) {
                    Button { decide(false) } label: { Text("Deny").frame(maxWidth: .infinity).frame(minHeight: 44) }
                        .foregroundStyle(StrataTheme.ink).background(StrataTheme.grouped, in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityIdentifier("denyMacAction-" + tool.id)
                    Button { decide(true) } label: { Text("Allow").frame(maxWidth: .infinity).frame(minHeight: 44) }
                        .foregroundStyle(StrataTheme.primaryInk).background(StrataTheme.primaryFill, in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityIdentifier("approveMacAction-" + tool.id)
                }
                .font(.subheadline.weight(.semibold)).buttonStyle(.plain).disabled(deciding)
            }
        }
        .padding(16).background(StrataTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(awaitingApproval ? StrataTheme.warning : StrataTheme.line, lineWidth: 1))
    }

    @ViewBuilder private var details: some View {
        if let preview = tool.preview, !preview.isEmpty, preview != tool.target {
            Text(preview).font(.caption.monospaced()).foregroundStyle(StrataTheme.ink).textSelection(.enabled)
        }
        if let effect = tool.effect, !effect.isEmpty, effect != tool.preview {
            Text(effect).font(.caption).foregroundStyle(StrataTheme.secondaryInk)
        }
        if let result = tool.result, !result.isEmpty {
            Divider()
            Text(result).font(.caption).foregroundStyle(StrataTheme.ink).textSelection(.enabled)
                .accessibilityIdentifier("macActivityResult")
        }
    }
}
