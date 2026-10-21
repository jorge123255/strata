import Foundation

// Original Strata geometry, shared verbatim with the web renderer fixture.
// Coordinates use head radii; geometric characters have no animal details.
enum GeometricAvatarGeometry {
    static let leftX = -0.37
    static let rightX = 0.37
    static let eyeY = -0.06
    static let paths: [AvatarShape: String] = [
        .orb: "M0-1.04C.58-1.04 1.04-.58 1.04 0C1.04.58.58 1.04 0 1.04C-.58 1.04-1.04.58-1.04 0C-1.04-.58-.58-1.04 0-1.04Z",
        .pebble: "M-.81-.65C-.47-1.09.21-1.12.68-.77C1.09-.46 1.15.19.83.67C.53 1.12-.18 1.15-.65.87C-1.12.59-1.16-.19-.81-.65Z",
        .tile: "M-.65-1.02H.65Q1.02-1.02 1.02-.65V.65Q1.02 1.02.65 1.02H-.65Q-1.02 1.02-1.02.65V-.65Q-1.02-1.02-.65-1.02Z",
        .diamond: "M-.19-1.01Q0-1.2.19-1.01L1.01-.19Q1.2 0 1.01.19L.19 1.01Q0 1.2-.19 1.01L-1.01.19Q-1.2 0-1.01-.19Z",
        .spark: "M0-1.13L.31-.74L.8-.8L.74-.31L1.13 0L.74.31L.8.8L.31.74L0 1.13L-.31.74L-.8.8L-.74.31L-1.13 0L-.74-.31L-.8-.8L-.31-.74Z",
        .hexagon: "M-.43-1H.43Q.59-1 .67-.86L1.1-.14Q1.18 0 1.1.14L.67.86Q.59 1 .43 1H-.43Q-.59 1-.67.86L-1.1.14Q-1.18 0-1.1-.14L-.67-.86Q-.59-1-.43-1Z",
    ]
}
