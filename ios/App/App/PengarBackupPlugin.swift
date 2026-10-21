import Capacitor
import Foundation
import UIKit

/// Respaldo automático de Pengar: escribe, lista, lee y borra los respaldos (.json) en una carpeta «Respaldos».
/// Con iCloud (la app compilada con la capability iCloud → iCloud Documents, que pide la cuenta paga, y iCloud Drive
/// prendido en el iPhone) es <contenedor de iCloud>/Documents/Respaldos, con NSFileCoordinator para no chocar con la
/// sincronización. Si no, Documents/Respaldos de la app: se ve en Archivos → En mi iPhone → Pengar
/// (UIFileSharingEnabled en Info.plist) y entra en el respaldo del iPhone en iCloud. El proyecto no trae el
/// entitlement de iCloud (con un Apple ID gratis no firma): cómo activarlo, en el README.
@objc(PengarBackupPlugin)
public class PengarBackupPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PengarBackupPlugin"
    public let jsName = "PengarBackup"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    /// Todo lo de archivos, de a uno y fuera del hilo principal (buscar el contenedor de iCloud puede demorar)
    private let queue = DispatchQueue(label: "uy.pengar.backup", qos: .utility)
    private static let folderName = "Respaldos"
    /// Lo que espera `read` a que un respaldo baje de iCloud
    private static let downloadTimeout: TimeInterval = 30

    private enum Location: String {
        case icloud, local
    }

    private struct Folder {
        let url: URL
        let location: Location
    }

    private struct BackupError: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    // MARK: - Dónde

    /// La carpeta en iCloud, si la app tiene el contenedor y el iPhone iCloud Drive (si no, nil). `nil` en
    /// `forUbiquityContainerIdentifier`: el primer contenedor de los entitlements, sea cual sea su nombre
    private func cloudFolder() -> URL? {
        let fm = FileManager.default
        guard fm.ubiquityIdentityToken != nil, let container = fm.url(forUbiquityContainerIdentifier: nil) else { return nil }
        return container
            .appendingPathComponent("Documents", isDirectory: true)
            .appendingPathComponent(Self.folderName, isDirectory: true)
    }

    private func localFolder() throws -> URL {
        let docs = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return docs.appendingPathComponent(Self.folderName, isDirectory: true)
    }

    private func folder() throws -> Folder {
        if let cloud = cloudFolder() { return Folder(url: cloud, location: .icloud) }
        return Folder(url: try localFolder(), location: .local)
    }

    /// «iCloud Drive › Pengar › Respaldos» o «Archivos › En mi iPhone › Pengar › Respaldos»
    private func legible(_ location: Location) -> String {
        let app = (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String) ?? "Pengar"
        switch location {
        case .icloud:
            // Sin NSUbiquitousContainers en Info.plist van a iCloud igual, pero la carpeta no aparece en iCloud Drive
            let visible = Bundle.main.object(forInfoDictionaryKey: "NSUbiquitousContainers") != nil
            return visible ? "iCloud Drive › \(app) › \(Self.folderName)" : "iCloud (la carpeta no se ve en Archivos: ver el README)"
        case .local:
            return "Archivos › En mi iPhone › \(app) › \(Self.folderName)"
        }
    }

    /// Pide a iOS un rato para terminar aunque la app pase a segundo plano. Devuelve cómo avisar que terminó
    private static func backgroundTask() -> () -> Void {
        let lock = NSLock()
        var id = UIBackgroundTaskIdentifier.invalid
        let end = {
            lock.lock()
            defer { lock.unlock() }
            guard id != .invalid else { return }
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
        let begun = UIApplication.shared.beginBackgroundTask(withName: "PengarBackup", expirationHandler: end)
        lock.lock()
        id = begun
        lock.unlock()
        return end
    }

    /// Solo un nombre de archivo, sin carpetas: que no se pueda leer ni escribir fuera de «Respaldos»
    private static func validName(_ name: String?) -> String? {
        guard let name = name, !name.isEmpty, name.count <= 200, !name.hasPrefix("."),
              !name.contains("/"), !name.contains("\\") else { return nil }
        return name
    }

    /// El marcador de uno que todavía no bajó de iCloud (iOS 16 y anteriores): «.pengar-2026-10-21.json.icloud»
    private static func placeholder(of url: URL) -> URL {
        url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
    }

    // MARK: - Métodos

    /// `iCloud`: si van a iCloud; `location`: icloud | local; `folder`: dónde se ven, para leer
    @objc func status(_ call: CAPPluginCall) {
        queue.async {
            let location: Location = self.cloudFolder() != nil ? .icloud : .local
            call.resolve(["iCloud": location == .icloud, "location": location.rawValue, "folder": self.legible(location)])
        }
    }

    /// `name`, `data` (texto, o base64 con `encoding: "base64"`). Pisa el que tenga el mismo nombre. Devuelve `location`
    @objc func write(_ call: CAPPluginCall) {
        guard let name = Self.validName(call.getString("name")) else {
            call.reject("Nombre de archivo inválido", "invalid")
            return
        }
        guard let text = call.getString("data") else {
            call.reject("Falta el contenido del respaldo", "invalid")
            return
        }
        let decoded = call.getString("encoding") == "base64" ? Data(base64Encoded: text) : text.data(using: .utf8)
        guard let bytes = decoded else {
            call.reject("El contenido del respaldo no se entiende", "invalid")
            return
        }
        // El respaldo de cuando la app pasa a segundo plano: que iOS no la suspenda a mitad de la escritura
        let finish = Self.backgroundTask()
        queue.async {
            defer { finish() }
            do {
                let folder = try self.folder()
                try FileManager.default.createDirectory(at: folder.url, withIntermediateDirectories: true)
                let url = folder.url.appendingPathComponent(name)
                if folder.location == .icloud {
                    try self.coordinate(writing: url, options: .forReplacing) { try bytes.write(to: $0, options: .atomic) }
                    self.adoptLocal(into: folder.url)
                } else {
                    try bytes.write(to: url, options: .atomic)
                }
                call.resolve(["location": folder.location.rawValue])
            } catch {
                call.reject("No se pudo guardar el respaldo: \(error.localizedDescription)", "write", error)
            }
        }
    }

    /// `files`: [{ name, size (bytes; 0 si no se sabe), modified (ms) }] de los .json, del más nuevo al más viejo
    @objc func list(_ call: CAPPluginCall) {
        queue.async {
            do {
                let folder = try self.folder()
                if folder.location == .icloud { self.adoptLocal(into: folder.url) }
                call.resolve(["files": try self.entries(in: folder.url)])
            } catch {
                call.reject("No se pudieron ver los respaldos: \(error.localizedDescription)", "list", error)
            }
        }
    }

    /// `data`: el contenido como texto (o base64 con `encoding: "base64"`). Si está solo en iCloud, lo baja primero
    @objc func read(_ call: CAPPluginCall) {
        guard let name = Self.validName(call.getString("name")) else {
            call.reject("Nombre de archivo inválido", "invalid")
            return
        }
        let base64 = call.getString("encoding") == "base64"
        queue.async {
            do {
                let folder = try self.folder()
                let url = folder.url.appendingPathComponent(name)
                let bytes: Data
                if folder.location == .icloud {
                    try self.download(url)
                    bytes = try self.coordinate(reading: url)
                } else {
                    bytes = try Data(contentsOf: url)
                }
                if base64 {
                    call.resolve(["data": bytes.base64EncodedString()])
                } else if let text = String(data: bytes, encoding: .utf8) {
                    call.resolve(["data": text])
                } else {
                    throw BackupError("no es un archivo de texto")
                }
            } catch {
                call.reject("No se pudo leer el respaldo: \(error.localizedDescription)", "read", error)
            }
        }
    }

    /// Borra uno (si no está, no pasa nada)
    @objc func remove(_ call: CAPPluginCall) {
        guard let name = Self.validName(call.getString("name")) else {
            call.reject("Nombre de archivo inválido", "invalid")
            return
        }
        queue.async {
            do {
                let fm = FileManager.default
                let folder = try self.folder()
                let url = folder.url.appendingPathComponent(name)
                let mark = Self.placeholder(of: url)
                // Uno que no bajó (iOS 16 y anteriores) es solo el marcador: borrarlo lo borra de iCloud
                let target: URL? = fm.fileExists(atPath: url.path) ? url : (fm.fileExists(atPath: mark.path) ? mark : nil)
                if let target = target {
                    if folder.location == .icloud {
                        try self.coordinate(writing: target, options: .forDeleting) { try FileManager.default.removeItem(at: $0) }
                    } else {
                        try fm.removeItem(at: target)
                    }
                }
                call.resolve()
            } catch {
                call.reject("No se pudo borrar el respaldo: \(error.localizedDescription)", "remove", error)
            }
        }
    }

    // MARK: - Archivos

    private func entries(in dir: URL) throws -> [[String: Any]] {
        let fm = FileManager.default
        guard fm.fileExists(atPath: dir.path) else { return [] }
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
        var byName: [String: (size: Int, modified: Date)] = [:]
        for url in try fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys, options: []) {
            var name = url.lastPathComponent
            let values = try? url.resourceValues(forKeys: Set(keys))
            let size: Int
            if name.hasPrefix(".") {
                guard name.hasSuffix(".icloud") else { continue }
                name = String(name.dropFirst().dropLast(".icloud".count))
                // Si ya está el archivo de verdad, vale ese
                if byName[name] != nil { continue }
                size = (NSDictionary(contentsOf: url)?["NSURLFileSizeKey"] as? NSNumber)?.intValue ?? 0
            } else {
                guard values?.isRegularFile == true else { continue }
                size = values?.fileSize ?? 0
            }
            guard name.lowercased().hasSuffix(".json") else { continue }
            byName[name] = (size, values?.contentModificationDate ?? Date(timeIntervalSince1970: 0))
        }
        return byName
            .sorted { $0.value.modified > $1.value.modified }
            .map { entry -> [String: Any] in
                ["name": entry.key, "size": entry.value.size, "modified": (entry.value.modified.timeIntervalSince1970 * 1000).rounded()]
            }
    }

    /// ¿Está en el iPhone y al día? (lo que no es de iCloud: si existe)
    private func downloaded(_ url: URL) -> URLUbiquitousItemDownloadingStatus? {
        var fresh = url
        fresh.removeAllCachedResourceValues()
        guard let values = try? fresh.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey]) else { return nil }
        if values.isUbiquitousItem != true { return FileManager.default.fileExists(atPath: url.path) ? .current : nil }
        return values.ubiquitousItemDownloadingStatus
    }

    /// Si el iPhone liberó lugar y el respaldo quedó solo en iCloud, lo baja y espera (hasta `downloadTimeout`).
    /// Sin conexión vale la copia vieja, si hay
    private func download(_ url: URL) throws {
        if downloaded(url) == .current { return }
        try FileManager.default.startDownloadingUbiquitousItem(at: url)
        let deadline = Date().addingTimeInterval(Self.downloadTimeout)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.5)
            if downloaded(url) == .current { return }
        }
        if downloaded(url) == .downloaded { return }
        throw BackupError("no terminó de bajar de iCloud. Revisá la conexión y probá de nuevo")
    }

    /// Escribe o borra coordinado con iCloud
    private func coordinate(writing url: URL, options: NSFileCoordinator.WritingOptions, _ work: (URL) throws -> Void) throws {
        var coordinatorError: NSError?
        var workError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: options, error: &coordinatorError) { target in
            do { try work(target) } catch { workError = error }
        }
        if let error = coordinatorError ?? workError { throw error }
    }

    private func coordinate(reading url: URL) throws -> Data {
        var coordinatorError: NSError?
        var result: Result<Data, Error> = .failure(BackupError("no se pudo abrir"))
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordinatorError) { target in
            result = Result { try Data(contentsOf: target) }
        }
        if let error = coordinatorError { throw error }
        return try result.get()
    }

    /// Con iCloud recién activado, los respaldos que habían quedado en el iPhone pasan a iCloud Drive (salvo los que
    /// ya estén allá con el mismo nombre). Si alguno no se puede (iCloud lleno), queda en el iPhone
    private func adoptLocal(into cloud: URL) {
        let fm = FileManager.default
        guard let local = try? localFolder(),
              let names = try? fm.contentsOfDirectory(atPath: local.path), !names.isEmpty else { return }
        try? fm.createDirectory(at: cloud, withIntermediateDirectories: true)
        for name in names where !name.hasPrefix(".") && name.lowercased().hasSuffix(".json") {
            let dest = cloud.appendingPathComponent(name)
            guard !fm.fileExists(atPath: dest.path), !fm.fileExists(atPath: Self.placeholder(of: dest).path) else { continue }
            do {
                try fm.setUbiquitous(true, itemAt: local.appendingPathComponent(name), destinationURL: dest)
            } catch {
                print("PengarBackup: no se pudo pasar \(name) a iCloud: \(error.localizedDescription)")
            }
        }
    }
}
