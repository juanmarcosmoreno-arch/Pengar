import Capacitor
import UIKit
import Vision

/// Lee el texto de una foto (ticket o factura) con Vision, en el teléfono y sin conexión.
/// Devuelve cada pedazo de texto con su caja; el armado de renglones y la lectura de la factura se hacen en JS.
@objc(PengarOCRPlugin)
public class PengarOCRPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PengarOCRPlugin"
    public let jsName = "PengarOCR"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "recognize", returnType: CAPPluginReturnPromise),
    ]

    /// Recibe un JPEG en base64 (ya orientado) y devuelve `boxes`: texto con x, y, w, h normalizados (origen arriba a la izquierda).
    @objc func recognize(_ call: CAPPluginCall) {
        guard let base64 = call.getString("image"),
              let data = Data(base64Encoded: base64),
              let image = UIImage(data: data),
              let cgImage = image.cgImage
        else {
            call.reject("Imagen inválida", "INVALID_IMAGE")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            // Los tickets tienen abreviaturas y códigos: la corrección de idioma los «arregla» mal
            request.usesLanguageCorrection = false
            request.minimumTextHeight = 0.004
            if #available(iOS 16.0, *) {
                request.automaticallyDetectsLanguage = false
            }
            if let supported = try? request.supportedRecognitionLanguages() {
                let wanted = ["es-ES", "es-MX", "en-US"].filter { supported.contains($0) }
                if !wanted.isEmpty { request.recognitionLanguages = wanted }
            }

            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
            do {
                try handler.perform([request])
                let boxes: [[String: Any]] = (request.results ?? []).compactMap { observation in
                    guard let candidate = observation.topCandidates(1).first else { return nil }
                    let box = observation.boundingBox // normalizado, origen abajo a la izquierda
                    return [
                        "text": candidate.string,
                        "x": Double(box.minX),
                        "y": Double(1 - box.maxY),
                        "w": Double(box.width),
                        "h": Double(box.height),
                    ]
                }
                call.resolve(["boxes": boxes])
            } catch {
                call.reject(error.localizedDescription, "VISION_ERROR", error)
            }
        }
    }
}
