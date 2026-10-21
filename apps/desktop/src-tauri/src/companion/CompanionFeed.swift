// Bounded owner-local feed. No redirects, persistent cache, cookies or credentials.
import Foundation

final class CompanionFeedRequest: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    private let url: URL
    private let token: String
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var data = Data()
    private var finished = false
    private let completion: (Result<Data, Error>) -> Void

    init(url: URL, token: String, completion: @escaping (Result<Data, Error>) -> Void) {
        self.url = url; self.token = token; self.completion = completion
    }
    func start() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 4
        configuration.timeoutIntervalForResource = 6
        configuration.waitsForConnectivity = false
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        self.session = session
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        request.setValue(token, forHTTPHeaderField: "x-strata-companion")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = false
        let task = session.dataTask(with: request); self.task = task; task.resume()
    }
    func cancel() { session?.invalidateAndCancel() }
    private func finish(_ result: Result<Data, Error>) {
        guard !finished else { return }; finished = true
        session?.invalidateAndCancel(); session = nil; task = nil
        DispatchQueue.main.async { [completion] in completion(result) }
    }
    private func invalid() -> NSError { NSError(domain: "StrataCompanion", code: 2, userInfo: [NSLocalizedDescriptionKey: "The companion feed is unavailable."]) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.url == url, response.mimeType == "application/json",
              response.expectedContentLength <= Int64(CompanionSnapshot.maximumBytes) else {
            completionHandler(.cancel); finish(.failure(invalid())); return
        }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        guard !finished else { return }
        // Check BEFORE appending, including chunked/unknown-length responses.
        guard chunk.count <= CompanionSnapshot.maximumBytes - data.count else { finish(.failure(invalid())); return }
        data.append(chunk)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finish(.failure(error)) } else { finish(.success(data)) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil); finish(.failure(invalid()))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(.cancelAuthenticationChallenge, nil); finish(.failure(invalid()))
    }
}
