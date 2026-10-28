import SwiftUI

extension ElicitationForm.Problem {
  /// The sentence under the form, in the phone's language (the web's wording in English).
  var message: String {
    switch self {
    case .required(let label): L("claudex_form_problem_required", label)
    case .chooseOne(let label): L("claudex_form_problem_choose_one", label)
    case .number(let label): L("claudex_form_problem_number", label)
    case .integer(let label): L("claudex_form_problem_integer", label)
    case .minimum(let label, let limit): L("claudex_form_problem_minimum", label, ElicitationForm.format(limit))
    case .maximum(let label, let limit): L("claudex_form_problem_maximum", label, ElicitationForm.format(limit))
    case .minLength(let label, let limit): L("claudex_form_problem_min_length", label, String(limit))
    case .maxLength(let label, let limit): L("claudex_form_problem_max_length", label, String(limit))
    case .email(let label): L("claudex_form_problem_email", label)
    case .uri(let label): L("claudex_form_problem_uri", label)
    case .dateTime(let label): L("claudex_form_problem_date_time", label)
    }
  }
}

/// The fields of a tool's form (MCP elicitation): text, number, switch, a menu for one choice and
/// checkboxes for several, a `*` on required ones. The rules and the answer are `ElicitationForm`'s
/// (the web card's, `src/approval/elicitation-form.ts`); the first problem reads under the fields.
struct ElicitationFormFields: View {
  let fields: [ElicitationForm.Field]
  @Binding var values: [String: ElicitationForm.Value]
  let problem: ElicitationForm.Problem?
  /// Called when a value changes, so the card can clear its problem.
  let edited: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      ForEach(fields) { field in
        VStack(alignment: .leading, spacing: 6) {
          if field.type != .boolean { label(field) }
          if let note = field.description, !note.isEmpty {
            Text(note).typeStyle(.caption).foregroundStyle(Palette.text300).fixedSize(horizontal: false, vertical: true)
          }
          control(field)
        }
      }
      if let problem {
        Text(problem.message).typeStyle(.caption).foregroundStyle(Palette.dangerText)
          .accessibilityAddTraits(.updatesFrequently).accessibilityIdentifier("form-problem")
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }

  private func label(_ field: ElicitationForm.Field) -> some View {
    HStack(spacing: 2) {
      Text(field.label).typeStyle(.bodyStrong).foregroundStyle(Palette.text100)
      if field.required {
        Text("*").typeStyle(.bodyStrong).foregroundStyle(Palette.text300).accessibilityLabel(L("claudex_form_required_label"))
      }
    }
  }

  private func text(_ field: ElicitationForm.Field) -> Binding<String> {
    Binding(
      get: { if case .text(let value) = values[field.name] ?? field.initial { return value }; return "" },
      set: { values[field.name] = .text($0); edited() })
  }
  private func flag(_ field: ElicitationForm.Field) -> Binding<Bool> {
    Binding(
      get: { if case .flag(let value) = values[field.name] ?? field.initial { return value }; return false },
      set: { values[field.name] = .flag($0); edited() })
  }
  private func chosen(_ field: ElicitationForm.Field) -> [String] {
    if case .list(let value) = values[field.name] ?? field.initial { return value }
    return []
  }

  @ViewBuilder private func control(_ field: ElicitationForm.Field) -> some View {
    switch field.type {
    case .boolean:
      Toggle(isOn: flag(field)) {
        HStack(spacing: 2) {
          Text(field.label).typeStyle(.body).foregroundStyle(Palette.text100)
          if field.required { Text("*").typeStyle(.body).foregroundStyle(Palette.text300).accessibilityLabel(L("claudex_form_required_label")) }
        }
      }.accessibilityIdentifier("form-field-\(field.name)")
    case .choice:
      choiceMenu(field)
    case .multi:
      VStack(alignment: .leading, spacing: 0) {
        ForEach(field.options, id: \.value) { option in
          let on = chosen(field).contains(option.value)
          HStack(spacing: 8) {
            ClaudeCheckbox(isOn: Binding(get: { on }, set: { _ in toggle(option.value, in: field) }))
            Text(option.label).typeStyle(.body).foregroundStyle(Palette.text100).frame(maxWidth: .infinity, alignment: .leading)
          }
          .contentShape(Rectangle()).onTapGesture { toggle(option.value, in: field) }
          .accessibilityElement(children: .combine).accessibilityAddTraits(on ? [.isSelected] : [])
        }
      }
    default:
      ClaudeTextField("", text: text(field), shape: .rounded, identifier: "form-field-\(field.name)")
        .keyboardType(keyboard(field))
        .textInputAutocapitalization(field.type == .string && field.format == nil ? .sentences : .never)
        .autocorrectionDisabled(field.type != .string || field.format != nil)
    }
  }

  private func keyboard(_ field: ElicitationForm.Field) -> UIKeyboardType {
    switch field.type {
    case .integer, .number: return .numbersAndPunctuation
    default:
      switch field.format {
      case "email": return .emailAddress
      case "uri": return .URL
      default: return .default
      }
    }
  }

  private func toggle(_ value: String, in field: ElicitationForm.Field) {
    var list = chosen(field)
    if let index = list.firstIndex(of: value) { list.remove(at: index) } else { list.append(value) }
    values[field.name] = .list(list)
    edited()
  }

  /// One choice: a native menu showing the choice (or "Choose…"), with "None" for an optional field.
  private func choiceMenu(_ field: ElicitationForm.Field) -> some View {
    let current = text(field).wrappedValue
    let shown = field.options.first { $0.value == current }?.label
    return Menu {
      if !field.required { Button(L("claudex_form_none")) { text(field).wrappedValue = "" } }
      ForEach(field.options, id: \.value) { option in
        Button { text(field).wrappedValue = option.value } label: {
          if option.value == current { Label(option.label, systemImage: "checkmark") } else { Text(option.label) }
        }
      }
    } label: {
      HStack(spacing: 8) {
        Text(shown ?? L("claudex_form_choose")).typeStyle(.body)
          .foregroundStyle(shown == nil ? Palette.text500 : Palette.text100).frame(maxWidth: .infinity, alignment: .leading)
        AppGlyphView(.caretUpCaretDown, size: 16).foregroundStyle(Palette.text300)
      }
      .padding(.horizontal, 16).padding(.vertical, 16).frame(minHeight: 54)
      .background(Palette.bg300, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    }.accessibilityIdentifier("form-field-\(field.name)")
  }
}
