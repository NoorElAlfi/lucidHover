// Fixture for manually verifying the LucidHover hover provider (Session 24 -- TypeScript).
// Hover over each function name below and confirm the tooltip echoes its raw source.

function add(a: number, b: number): number {
    return a + b;
}

function greet(name: string): string {
    const message = `Hello, ${name}!`;
    console.log(message);
    return message;
}

const double = (n: number): number => {
    return n * 2;
};

const makeCounter = (): (() => number) => {
    let count = 0;
    return function increment(): number {
        count += 1;
        return count;
    };
};
