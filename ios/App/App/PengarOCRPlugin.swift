import Capacitor
import PDFKit
import UIKit
import Vision

/// Lee el texto de una foto (ticket o factura) con Vision, en el teléfono y sin conexión.
/// Devuelve cada pedazo de texto con su caja; el armado de renglones y la lectura de la factura se hacen en JS.
/// En los tickets también lee el QR de la DGI y trae el ticket oficial que publica el súper (fetchCfe).
@objc(PengarOCRPlugin)
public class PengarOCRPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PengarOCRPlugin"
    public let jsName = "PengarOCR"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "recognize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchCfe", returnType: CAPPluginReturnPromise),
    ]

    /// Recibe un JPEG en base64 (ya orientado) y devuelve `boxes`: texto con x, y, w, h normalizados (origen arriba a la izquierda)
    /// y su inclinación (`slope`, en píxeles: con eso JS endereza la foto, como en Kvar).
    /// Con `qr: true` también lee los códigos QR de la misma foto y los devuelve en `qr`.
    @objc func recognize(_ call: CAPPluginCall) {
        guard let base64 = call.getString("image"),
              let data = Data(base64Encoded: base64),
              let image = UIImage(data: data),
              let cgImage = image.cgImage
        else {
            call.reject("Imagen inválida", "INVALID_IMAGE")
            return
        }
        let width = Double(cgImage.width)
        let height = Double(cgImage.height)
        let wantsQR = call.getBool("qr") ?? false

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

            // El QR del ticket (link de la DGI) en la misma pasada, sobre la misma imagen
            let barcodes = VNDetectBarcodesRequest()
            barcodes.symbologies = [.qr]
            let requests: [VNRequest] = wantsQR ? [request, barcodes] : [request]

            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
            do {
                do {
                    try handler.perform(requests)
                } catch {
                    // Si falla el lector de QR (en el simulador, por ejemplo), el texto se lee igual
                    guard wantsQR else { throw error }
                    try handler.perform([request])
                }
                let boxes: [[String: Any]] = (request.results ?? []).compactMap { observation in
                    guard let candidate = observation.topCandidates(1).first else { return nil }
                    let box = observation.boundingBox // normalizado, origen abajo a la izquierda
                    let topLeft = observation.topLeft
                    let topRight = observation.topRight
                    let dx = Double(topRight.x - topLeft.x) * width
                    let dy = Double(topLeft.y - topRight.y) * height // positiva si baja hacia la derecha
                    return [
                        "text": candidate.string,
                        "x": Double(box.minX),
                        "y": Double(1 - box.maxY),
                        "w": Double(box.width),
                        "h": Double(box.height),
                        "slope": dx > 1 ? dy / dx : 0.0,
                    ]
                }
                var qr: [String] = []
                if wantsQR {
                    for observation in barcodes.results ?? [] {
                        if let payload = observation.payloadStringValue, !qr.contains(payload) {
                            qr.append(payload)
                        }
                    }
                }
                call.resolve(["boxes": boxes, "qr": qr])
            } catch {
                call.reject(error.localizedDescription, "VISION_ERROR", error)
            }
        }
    }

    // MARK: - Ticket oficial

    /// Disco, Devoto, Géant y Macromercado publican el ticket en Rondanet (sin CORS: por eso se pide desde acá).
    /// El Dorado usa Scanntech: sin probar, no está activado.
    private static let rondanetURL = URL(string: "https://cfe.rondanet.com/cgi-bin/Publicacion.cgi")!

    /// Pide el ticket oficial con los datos del QR (ruc, tipo, serie, numero, total «1620.19», hash6) y devuelve
    /// `lines`: los renglones de la primera página del PDF en orden de lectura, hasta «TOTAL A PAGAR».
    /// La ADENDA (nombre del cliente, tarjeta) y la página del pago nunca se leen.
    /// Errores: «no-publicado» (Rondanet dice «Datos no válidos»), «red» (sin conexión), «formato», «datos».
    @objc func fetchCfe(_ call: CAPPluginCall) {
        let keys = ["ruc", "tipo", "serie", "numero", "total", "hash6"]
        let values = keys.map { (call.getString($0) ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
        if values.contains(where: { $0.isEmpty }) {
            call.reject("Faltan datos del ticket", "datos")
            return
        }
        if call.getString("portal") == "tienda-inglesa" {
            fetchTiendaInglesa(call, tipo: values[1], serie: values[2], numero: values[3], total: values[4], hash6: values[5])
            return
        }
        let fields: [(String, String)] = [
            ("RUT", values[0]), ("TipoCFE", values[1]), ("Serie", values[2]),
            ("Numero", values[3]), ("Total", values[4]), ("Hash6", values[5]),
        ]

        var request = URLRequest(url: PengarOCRPlugin.rondanetURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = "POST"
        // Igual que el formulario del súper (sin «charset»: todo es ASCII)
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/pdf, text/plain, */*", forHTTPHeaderField: "Accept")
        request.httpBody = PengarOCRPlugin.formBody(fields)

        // Sesión efímera: sin cookies ni caché en disco (el PDF trae datos personales en la ADENDA)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 25
        let session = URLSession(configuration: config)
        let task = session.dataTask(with: request) { data, response, error in
            session.finishTasksAndInvalidate()
            guard error == nil, let data = data, let http = response as? HTTPURLResponse else {
                call.reject("Sin conexión", "red")
                return
            }
            let mime = (http.mimeType ?? "").lowercased()
            let isPDF = mime.contains("pdf") || data.starts(with: [0x25, 0x50, 0x44, 0x46]) // «%PDF»
            if http.statusCode != 200 || !isPDF {
                let head = data.prefix(2000)
                let body = String(data: head, encoding: .utf8) ?? String(data: head, encoding: .isoLatin1) ?? ""
                let plain = body.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
                if plain.contains("datos no validos") {
                    call.reject("Todavía no está publicado o algún dato no coincide", "no-publicado")
                } else {
                    call.reject("Respuesta inesperada (HTTP \(http.statusCode))", http.statusCode >= 500 ? "red" : "formato")
                }
                return
            }
            guard let document = PDFDocument(data: data), let page = document.page(at: 0) else {
                call.reject("No se pudo leer el PDF", "formato")
                return
            }
            call.resolve(["lines": PengarOCRPlugin.lines(of: page)])
        }
        task.resume()
    }

    private static let tiendaInglesaURL = URL(string: "https://comprobantes.tiendainglesa.com.uy/henderson/")!

    /// Tienda Inglesa publica en su propio portal (Uruware), un formulario de ASP.NET: se pide la página (por sus campos
    /// ocultos), se manda tipo, serie, número, monto y código de seguridad y, en la misma sesión, se baja el PDF.
    /// Mismos errores que Rondanet: si algún dato no coincide, el portal vuelve al formulario con un aviso («no-publicado»).
    private func fetchTiendaInglesa(_ call: CAPPluginCall, tipo: String, serie: String, numero: String, total: String, hash6: String) {
        // Sesión efímera: las cookies de la consulta quedan en memoria y se borran al terminar (el PDF trae datos personales)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 25
        let session = URLSession(configuration: config)
        let base = PengarOCRPlugin.tiendaInglesaURL
        func fail(_ message: String, _ code: String) {
            session.invalidateAndCancel()
            call.reject(message, code)
        }

        let form = URLRequest(url: base, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        session.dataTask(with: form) { data, _, error in
            guard error == nil, let data = data, let html = String(data: data, encoding: .utf8) else {
                fail("Sin conexión", "red")
                return
            }
            let hidden = ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION"].map { ($0, PengarOCRPlugin.hiddenValue($0, in: html) ?? "") }
            if hidden[0].1.isEmpty {
                fail("Respuesta inesperada", "formato")
                return
            }
            let fields = hidden + [
                ("__EVENTTARGET", "search"), ("__EVENTARGUMENT", ""), ("type", tipo), ("serie", serie),
                ("number", numero), ("monto", total), ("codigoSeguridad", hash6),
            ]
            var post = URLRequest(url: base, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
            post.httpMethod = "POST"
            post.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            post.httpBody = PengarOCRPlugin.formBody(fields)
            session.dataTask(with: post) { data, response, error in
                guard error == nil, let data = data, let http = response as? HTTPURLResponse else {
                    fail("Sin conexión", "red")
                    return
                }
                // Si los datos coinciden, lleva a MostrarCfe.aspx (la redirección se sigue sola)
                if http.statusCode != 200 || http.url?.lastPathComponent.lowercased() != "mostrarcfe.aspx" {
                    let body = String(data: data.prefix(40000), encoding: .utf8) ?? ""
                    if http.statusCode == 200 && body.contains("LaunchWarningFancyBox") {
                        fail("Todavía no está publicado o algún dato no coincide", "no-publicado")
                    } else {
                        fail("Respuesta inesperada (HTTP \(http.statusCode))", http.statusCode >= 500 ? "red" : "formato")
                    }
                    return
                }
                guard let pdfURL = URL(string: "DescargarPDF.aspx", relativeTo: base) else {
                    fail("Respuesta inesperada", "formato")
                    return
                }
                let download = URLRequest(url: pdfURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
                session.dataTask(with: download) { data, _, error in
                    guard error == nil, let data = data else {
                        fail("Sin conexión", "red")
                        return
                    }
                    session.finishTasksAndInvalidate()
                    guard data.starts(with: [0x25, 0x50, 0x44, 0x46]), // «%PDF»
                          let document = PDFDocument(data: data), let page = document.page(at: 0) else {
                        call.reject("No se pudo leer el PDF", "formato")
                        return
                    }
                    call.resolve(["lines": PengarOCRPlugin.lines(of: page)])
                }.resume()
            }.resume()
        }.resume()
    }

    /// El valor de un campo oculto del formulario («<input type="hidden" name="__VIEWSTATE" … value="…" />»)
    private static func hiddenValue(_ name: String, in html: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: "name=\"\(name)\"[^>]*value=\"([^\"]*)\"") else { return nil }
        guard let match = regex.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
              let range = Range(match.range(at: 1), in: html) else { return nil }
        return String(html[range])
    }

    /// Formulario «application/x-www-form-urlencoded»: el «+» y la «/» del código van escapados («%2B», «%2F»)
    private static func formBody(_ fields: [(String, String)]) -> Data? {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        let pairs = fields.map { field -> String in
            let value = field.1.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
            return "\(field.0)=\(value)"
        }
        return pairs.joined(separator: "&").data(using: .utf8)
    }

    /// Un pedazo de texto del PDF con su posición (coordenadas del PDF: la y crece hacia arriba)
    private struct Piece {
        let x: CGFloat
        let y: CGFloat
        let height: CGFloat
        let text: String
    }

    /// Renglones de la página en orden de lectura: de arriba abajo y, en cada uno, de izquierda a derecha (las columnas
    /// de la tabla pueden venir como pedazos separados). Termina en «TOTAL A PAGAR»; lo de la ADENDA nunca sale de acá.
    private static func lines(of page: PDFPage) -> [String] {
        guard let selection = page.selection(for: page.bounds(for: .mediaBox)) else { return [] }
        var pieces: [Piece] = []
        for line in selection.selectionsByLine() {
            let words = (line.string ?? "").components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }
            if words.isEmpty { continue }
            let box = line.bounds(for: page)
            pieces.append(Piece(x: box.minX, y: box.midY, height: max(box.height, 1), text: words.joined(separator: " ")))
        }
        pieces.sort { $0.y != $1.y ? $0.y > $1.y : $0.x < $1.x }

        // Pedazos a la misma altura (media letra de tolerancia) son el mismo renglón
        var rows: [[Piece]] = []
        for piece in pieces {
            if let first = rows.last?.first, abs(first.y - piece.y) <= min(first.height, piece.height) * 0.5 {
                rows[rows.count - 1].append(piece)
            } else {
                rows.append([piece])
            }
        }

        var out: [String] = []
        var afterTotal = false
        for row in rows {
            let text = row.sorted { $0.x < $1.x }.map { $0.text }.joined(separator: " ")
            let upper = text.uppercased()
            if upper.contains("ADENDA") { break }
            out.append(text)
            if afterTotal { break }
            if upper.contains("TOTAL A PAGAR") {
                // El monto puede quedar en el renglón de abajo
                if text.rangeOfCharacter(from: .decimalDigits) != nil { break }
                afterTotal = true
            }
        }
        return out
    }
}
