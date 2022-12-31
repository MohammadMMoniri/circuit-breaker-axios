import { AxiosInstance } from 'axios';

class InternalServerError extends Error {
    status = 500;
}

export type CircuitBreakerConfig = {
    // url of service
    readonly serviceUrl: string;
    // first timeout (it multiplies by 2 powers)
    readonly timeout: number;
    // count of requests for each open state circuit
    readonly maxRequest: number;
    // percentage to change state of circuit from close to open
    readonly failedPercentage: number;
    // not used yed
    readonly acceptableTimeOut: number;
    // percentage of requests that sent to destination in half-open state
    readonly halfOpenPercentage: number;
    // minimum percentage that must be to change state of circuit from half-open to close
    readonly halfToCloseMinPercentage: number;
    // count of requests that sent to destination in half-open state
    readonly halfOpenMaxRequests: number;
};

type CircuitBreakerDynamics = {
    // state of circuit (close: requests sent, open: requests ignored, half(half-open): checks the destination)
    state: 'close' | 'half' | 'open';
    // time of last request
    lastRequestTime: Date;
    // count of requests in each state
    counter: number;
    // unsuccessful request count in each state
    unsuccessfulCount: number;
    // count of consecutive open circuit
    consecutiveOpenCircuitCount: number;
};

type CircuitBreakerDataStructure = Omit<
    CircuitBreakerDynamics & CircuitBreakerConfig,
    'serviceUrl'
>;

export class CircuitBreaker {
    private circuitBreakerServices: string[] = [];

    private readonly BaseCircuitBreakerDataStatic: Omit<
        CircuitBreakerConfig,
        'serviceUrl'
    > = {
        timeout: 10 * 1000,
        maxRequest: 50,
        failedPercentage: 40,
        halfOpenPercentage: 10,
        halfOpenMaxRequests: 100,
        halfToCloseMinPercentage: 80,
        acceptableTimeOut: 4500,
    };

    private BaseCircuitBreakerDataDynamic: CircuitBreakerDynamics = {
        state: 'close',
        counter: 0,
        unsuccessfulCount: 0,
        lastRequestTime: new Date(),
        consecutiveOpenCircuitCount: 0,
    };

    private serviceData: {
        [key: string]: CircuitBreakerDataStructure;
    } = {};

    private changeStateCallback: (
        from: 'close' | 'half' | 'open',
        to: 'close' | 'half' | 'open',
        originName: string,
    ) => any;

    constructor(
        axiosRef: AxiosInstance,
        listOfServices: string[],
        config: { [key: string]: CircuitBreakerConfig } = {},
        callback?: (
            from: 'close' | 'half' | 'open',
            to: 'close' | 'half' | 'open',
            originName: string,
        ) => any,
    ) {
        try {
            listOfServices.forEach((el) => {
                new URL(el);
                this.circuitBreakerServices.push(el);
                let originConfig: CircuitBreakerDataStructure;

                config[el]
                    ? (originConfig = {
                          ...config[el],
                          ...this.BaseCircuitBreakerDataDynamic,
                      })
                    : (originConfig = {
                          ...this.BaseCircuitBreakerDataStatic,
                          ...this.BaseCircuitBreakerDataDynamic,
                      });
                this.serviceData[el] = originConfig;
            });

            if (callback) this.changeStateCallback = callback;

            axiosRef.interceptors.request.use(
                this.requestInterceptor.bind(this),
            );
            axiosRef.interceptors.response.use(
                this.responseInterceptor.bind(this),
                this.responseErrorInterceptor.bind(this),
            );
        } catch (e) {
            throw e;
        }
    }

    protected requestInterceptor(config) {
        try {
            const origin = new URL(config.url).origin;

            if (this.circuitBreakerServices.includes(origin)) {
                let originData = this.serviceData[origin];
                originData.counter++;                

                if (originData.state === 'open') {
                    this.open(originData, origin);
                } else if (originData.state === 'half') {
                    this.half(originData, origin);
                }
            }

            return config;
        } catch (e) {
            e.config = config;
            throw e;
        }
    }

    protected half(
        originData: CircuitBreakerDataStructure,
        originName: string,
    ) {
        if (originData.counter >= originData.halfOpenMaxRequests) {
            const requestCounts =
                (originData.halfOpenMaxRequests *
                    originData.halfOpenPercentage) /
                100;
            const realUnsuccessfulCount =
                originData.unsuccessfulCount -
                (originData.halfOpenMaxRequests - requestCounts);
            if (
                requestCounts - realUnsuccessfulCount >
                (requestCounts * originData.halfToCloseMinPercentage) / 100
            ) {
                this.changeState('half', 'close', originName, originData);
            } else {
                this.changeState('half', 'open', originName, originData);
            }
        }

        if (originData.counter % (100 / originData.halfOpenPercentage) === 0) {
            return;
        }
        throw new InternalServerError();
    }

    protected open(
        originData: CircuitBreakerDataStructure,
        originName: string,
    ) {
        if (
            originData.lastRequestTime.getTime() +
                originData.timeout *
                    2 ** originData.consecutiveOpenCircuitCount <
            new Date().getTime()
        ) {
            this.changeState('open', 'half', originName, originData);
        }
        throw new InternalServerError();
    }

    protected responseInterceptor(response) {
        response.config.metadata.endTime = new Date();
        response.duration =
            response.config.metadata.endTime -
            response.config.metadata.startTime;

        return response;
    }

    protected changeState(
        from: 'close' | 'half' | 'open',
        to: 'close' | 'half' | 'open',
        originName: string,
        originData: CircuitBreakerDataStructure,
    ) {
        if (from === to) {
            throw new Error();
        }

        originData.state = to;
        originData.counter = 0;
        originData.unsuccessfulCount = 0;
        originData.lastRequestTime = new Date();

        if (!(from === 'open' && to === 'half')) {
            if (from === 'half' && to === 'open') {
                originData.consecutiveOpenCircuitCount++;
            } else {
                originData.consecutiveOpenCircuitCount = 0;
            }
        }

        if (this.changeStateCallback)
            return this.changeStateCallback(from, to, originName);
        return;
    }

    protected responseErrorInterceptor(error) {
        const origin = new URL(error.config?.url || error.url).origin;
        const status = error.response?.status || null;

        if (
            (status === null || status % 500 < 100) &&
            this.circuitBreakerServices.includes(origin)
        ) {
            let originData: CircuitBreakerDataStructure =
                this.serviceData[origin];
            originData.unsuccessfulCount++;

            if (originData.state === 'close') {
                if (
                    originData.failedPercentage <
                    (originData.unsuccessfulCount / originData.maxRequest) * 100
                ) {
                    this.changeState('close', 'open', origin, originData);
                }
            }
        }
        return error;
    }
}
