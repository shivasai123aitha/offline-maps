export async function loadRoadNetwork(
    south,
    west,
    north,
    east
) {

    const query = `
    [out:json];

    (
      way["highway"]
        (${south},${west},${north},${east});
    );

    out body;
    >;
    out skel qt;
  `;

    const response = await fetch(
        "https://overpass-api.de/api/interpreter",
        {
            method: "POST",
            body: query
        }
    );

    if (!response.ok) {
        throw new Error("Failed to load OpenStreetMap data");
    }

    const data = await response.json();

    return buildGraph(data.elements);
}


function buildGraph(elements) {

    const nodes = {};
    const graph = {};

    // Store node coordinates
    for (const element of elements) {

        if (element.type === "node") {

            nodes[element.id] = {
                lat: element.lat,
                lon: element.lon
            };

            graph[element.id] = [];
        }
    }


    // Build roads
    for (const element of elements) {

        if (
            element.type !== "way" ||
            !element.nodes
        ) {
            continue;
        }

        const roadNodes = element.nodes;

        for (
            let i = 0;
            i < roadNodes.length - 1;
            i++
        ) {

            const from = roadNodes[i];
            const to = roadNodes[i + 1];

            if (
                !nodes[from] ||
                !nodes[to]
            ) {
                continue;
            }

            const distance = haversine(
                nodes[from],
                nodes[to]
            );

            graph[from].push({
                node: to,
                distance
            });

            graph[to].push({
                node: from,
                distance
            });
        }
    }

    return {
        graph,
        nodes
    };
}


function haversine(a, b) {

    const R = 6371;

    const lat1 =
        a.lat * Math.PI / 180;

    const lat2 =
        b.lat * Math.PI / 180;

    const dLat =
        (b.lat - a.lat) *
        Math.PI / 180;

    const dLon =
        (b.lon - a.lon) *
        Math.PI / 180;


    const x =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) *
        Math.cos(lat2) *
        Math.sin(dLon / 2) ** 2;


    const y =
        2 * Math.atan2(
            Math.sqrt(x),
            Math.sqrt(1 - x)
        );


    return R * y;
}

export function findNearestNode(
    nodes,
    lat,
    lon
) {

    let nearest = null;
    let minDistance = Infinity;


    for (const id in nodes) {

        const node = nodes[id];

        const distance =
            haversine(
                {
                    lat,
                    lon
                },
                node
            );


        if (distance < minDistance) {

            minDistance = distance;
            nearest = id;

        }
    }


    return nearest;
}