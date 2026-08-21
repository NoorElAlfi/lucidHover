// Fixture for manually verifying the LucidHover hover provider (Session 1).
// Hover over each function name below and confirm the tooltip echoes its raw source.

function add(a, b) {
    return a + b;
}

function greet(name) {
    const message = `Hello, ${name}!`;
    console.log(message);
    return message;
}

const double = (n) => {
    return n * 2;
};

const makeCounter = () => {
    let count = 0;
    return function increment() {
        count += 1;
        return count;
    };
};
