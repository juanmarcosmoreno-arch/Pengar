import Capacitor
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Sugerencias de rubro con Apple Intelligence (Foundation Models, iOS 26+): en el teléfono, sin conexión y sin costo.
/// Recibe comercios de la tarjeta o renglones de facturas y elige, para cada uno, un rubro de la lista que manda la web.
@objc(PengarAIPlugin)
public class PengarAIPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PengarAIPlugin"
    public let jsName = "PengarAI"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "classify", returnType: CAPPluginReturnPromise),
    ]

    /// El modelo del teléfono tiene poco contexto: de a 15 por pedido (y de a 5 si una tanda falla)
    private static let batchSize = 15
    private static let retrySize = 5

    // MARK: - Disponibilidad

    @objc func availability(_ call: CAPPluginCall) {
        call.resolve(["appleIntelligence": appleIntelligenceStatus()])
    }

    /// available | notEnabled | notEligible | notReady | unsupported | sdk
    private func appleIntelligenceStatus() -> String {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return "available"
            case .unavailable(let reason):
                switch reason {
                case .appleIntelligenceNotEnabled: return "notEnabled"
                case .deviceNotEligible: return "notEligible"
                case .modelNotReady: return "notReady"
                @unknown default: return "unsupported"
                }
            }
        }
        return "unsupported"
        #else
        // Compilado sin el SDK de iOS 26 (Xcode 16 o anterior): la app no trae Apple Intelligence aunque el iPhone lo tenga
        return "sdk"
        #endif
    }

    // MARK: - Rubros

    /// `items`: [{ id, text }], `options`: nombres de los rubros, `hint`: contexto opcional (la categoría de cada rubro).
    /// Devuelve `results`: [{ id, option }], con el nombre exacto de una de las opciones o «» si no está seguro.
    @objc func classify(_ call: CAPPluginCall) {
        let items: [(id: String, text: String)] = (call.getArray("items", JSObject.self) ?? []).compactMap { item in
            guard let id = item["id"] as? String, let text = item["text"] as? String else { return nil }
            return (id: id, text: text)
        }
        let options = (call.getArray("options", String.self) ?? []).filter { !$0.isEmpty }
        let hint = call.getString("hint") ?? ""
        guard !items.isEmpty, !options.isEmpty else {
            call.resolve(["results": items.map { ["id": $0.id, "option": ""] }])
            return
        }
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            guard case .available = SystemLanguageModel.default.availability else {
                call.unavailable("Apple Intelligence no está disponible")
                return
            }
            Task {
                var results: [[String: String]] = []
                var answered = false
                var lastError: Error?
                for start in stride(from: 0, to: items.count, by: PengarAIPlugin.batchSize) {
                    let batch = Array(items[start..<min(start + PengarAIPlugin.batchSize, items.count)])
                    var chosen = Array(repeating: "", count: batch.count)
                    do {
                        chosen = try await PengarAIPlugin.choose(batch.map { $0.text }, options: options, hint: hint)
                        answered = true
                    } catch {
                        // Mucho texto o algo que el modelo no quiere responder: se prueba en tandas más chicas
                        lastError = error
                        for sub in stride(from: 0, to: batch.count, by: PengarAIPlugin.retrySize) {
                            let end = min(sub + PengarAIPlugin.retrySize, batch.count)
                            guard let part = try? await PengarAIPlugin.choose(batch[sub..<end].map { $0.text }, options: options, hint: hint) else { continue }
                            chosen.replaceSubrange(sub..<end, with: part)
                            answered = true
                        }
                    }
                    results += zip(batch, chosen).map { ["id": $0.id, "option": $1] }
                }
                if !answered, let error = lastError {
                    call.reject(error.localizedDescription, "MODEL_ERROR", error)
                } else {
                    call.resolve(["results": results])
                }
            }
            return
        }
        #endif
        call.unavailable("Apple Intelligence no está disponible")
    }

    #if canImport(FoundationModels)
    /// Una tanda: devuelve, en el mismo orden, la opción elegida para cada texto (o «»)
    @available(iOS 26.0, *)
    private static func choose(_ texts: [String], options: [String], hint: String) async throws -> [String] {
        let session = LanguageModelSession(instructions: """
        Sos un asistente de finanzas personales en Uruguay. Te paso compras de una tarjeta de crédito o renglones \
        de una factura (comercios y productos de Uruguay, a veces abreviados o en mayúsculas) y una lista de rubros.
        Para cada comercio o renglón elegí el rubro más probable de la lista, escrito exactamente igual que en la lista.
        Si no estás seguro, o ningún rubro encaja, respondé con un texto vacío. No inventes rubros.
        """)
        var prompt = "Rubros posibles: \(options.joined(separator: "; "))\n"
        if !hint.isEmpty { prompt += "\(hint)\n" }
        prompt += "Comercios o renglones:\n"
        for (i, text) in texts.enumerated() { prompt += "\(i + 1). \(text)\n" }
        let response = try await session.respond(
            to: prompt, generating: PengarRubroChoices.self, options: GenerationOptions(temperature: 0.1))
        // Solo valen las opciones de la lista (sin importar mayúsculas ni tildes)
        var valid: [String: String] = [:]
        for option in options { valid[key(option)] = option }
        var chosen = Array(repeating: "", count: texts.count)
        for answer in response.content.answers {
            let i = answer.line - 1
            guard chosen.indices.contains(i) else { continue }
            chosen[i] = valid[key(answer.option)] ?? ""
        }
        return chosen
    }
    #endif

    private static func key(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "es"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

#if canImport(FoundationModels)
@available(iOS 26.0, *)
@Generable
struct PengarRubroChoices {
    @Guide(description: "Una respuesta por cada comercio o renglón de la lista, en el mismo orden")
    var answers: [PengarRubroChoice]
}

@available(iOS 26.0, *)
@Generable
struct PengarRubroChoice {
    @Guide(description: "El número del comercio o renglón en la lista")
    var line: Int
    @Guide(description: "El nombre exacto de uno de los rubros posibles, o vacío si no estás seguro")
    var option: String
}
#endif
